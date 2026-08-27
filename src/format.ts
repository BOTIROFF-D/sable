/**
 * Форматтер sable: разбирает исходник и печатает AST обратно в канонический вид.
 *
 * Правила оформления (единые, обсуждению на месте не подлежат):
 *   • отступ — два пробела, табов нет;
 *   • «{» остаётся на строке заголовка, «}» занимает свою строку,
 *     «else», «catch» и «finally» пишутся на строке закрывающей скобки;
 *   • тело из одной простой инструкции остаётся на строке заголовка, если влезает
 *     в ширину; структура из одних полей — тоже; остальное переносится,
 *     «}» своей строкой;
 *     пустое тело без комментариев внутри — «{}»;
 *   • вокруг бинарных операторов по одному пробелу, после унарных пробела нет;
 *     «..» пишется вплотную: 0..10, потому что это литерал диапазона, а не действие;
 *   • перед «(» вызова и перед «,» пробела нет, после «,» — есть;
 *   • списки, словари, аргументы и параметры переносятся по элементу на строку
 *     с висячей запятой, если строка не влезает в 100 символов; иначе одна строка;
 *   • список коротких однородных значений вместо столбца заполняет строки:
 *     таблица из тридцати чисел по строке на число не читается вовсе;
 *     Элемент с телом в фигурных скобках ломает список, даже если тот влезает, —
 *     кроме единственного элемента: `f(fn(a, b) { … })` привычнее переноса;
 *   • словарь пишется без внутренних отступов — {имя: "Ali"}, как список;
 *     ключ-строка, годная в имя, теряет кавычки: {"имя": 1} → {имя: 1};
 *   • между объявлениями верхнего уровня (fn, struct) и между методами структуры —
 *     ровно одна пустая строка; в остальных местах пустая строка сохраняется,
 *     если она была в исходнике, и никогда не идёт двумя подряд;
 *   • у структуры сначала поля, потом методы: в AST они лежат двумя списками,
 *     и порядок между ними всё равно не сохранён;
 *   • строковые литералы и числа переносятся из исходника посимвольно: кавычки,
 *     экранирование, вставки ${…}, 0xFF и 1_000_000 остаются как были;
 *   • скобки в выражениях расставляются по приоритетам заново — лишние исчезают,
 *     необходимые появляются (в том числе вокруг словаря в заголовке if/while/for);
 *   • у записей, которые парсер разбирает в одно дерево, каноническая — короткая:
 *     `fn(x) { return x * 2 }` → `x -> x * 2`,
 *     `and`/`or` → `&&`/`||` (словесное `not` до форматтера не доживает — лексер
 *     отдаёт «!», и держать половину синонимов было бы страннее).
 *
 * Комментарии. В AST их нет — лексер выбрасывает их молча, а править лексер
 * нельзя. Поэтому форматтер делает по исходнику собственный проход (scanSource)
 * и собирает комментарии с позициями, после чего раскладывает их по границам
 * инструкций: комментарий на своей строке печатается своей строкой перед
 * следующей инструкцией, комментарий после кода приклеивается к последней
 * напечатанной строке. Комментарий изнутри выражения (например, между
 * элементами списка, который форматтер собрал в одну строку) переезжает
 * к концу этой инструкции — но не теряется. Молча съесть комментарий
 * форматтер не может ни при каком входе; это проверяется тестом
 * (tests/format.ts сверяет список комментариев до и после).
 */
import type { Expr, Param, Program, Stmt } from './ast.ts';
import type { Span } from './errors.ts';
import { tokenize } from './lexer.ts';
import { parse } from './parser.ts';
import { KEYWORDS, type Token } from './token.ts';

/**
 * Инструкция, которую можно оставить на строке заголовка.
 * Вложенные блоки исключены: `if a { if b { c } }` читается хуже переноса.
 */
function inlinable(s: Stmt): boolean {
  return s.kind === 'VarDecl' || s.kind === 'ExprStmt' || s.kind === 'Return'
    || s.kind === 'Break' || s.kind === 'Continue' || s.kind === 'Import';
}

/** Предельная ширина строки; всё, что длиннее, переносится по элементу. */
const WIDTH = 100;

/** Насколько коротким должен быть элемент, чтобы класть в строку по несколько. */
const FILL_ITEM = 24;
const INDENT = '  ';

type Comment = {
  /** Смещение начала комментария в исходнике. */
  start: number;
  line: number;
  /** true, если перед комментарием на его строке только пробелы. */
  own: boolean;
  text: string;
};

type Scan = {
  comments: Comment[];
  /** Начало строкового литерала → смещение сразу за его закрывающей кавычкой. */
  strings: Map<number, number>;
};

const isIdentStart = (c: string): boolean => /[A-Za-z_À-ɏЀ-ӿ]/.test(c);
const isIdentPart = (c: string): boolean =>
  isIdentStart(c) || (c >= '0' && c <= '9') || /[ʻʼ‘’]/.test(c);

/** Можно ли записать ключ словаря без кавычек. */
function isBareKey(name: string): boolean {
  if (name === '') return false;
  const chars = [...name];
  if (!isIdentStart(chars[0]!)) return false;
  for (const c of chars) if (!isIdentPart(c)) return false;
  return !Object.prototype.hasOwnProperty.call(KEYWORDS, name);
}

/** Запасная запись строки — когда исходный текст литерала недоступен. */
function quote(value: string): string {
  let out = '"';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\0') out += '\\0';
    else if (ch === '$') out += '\\$';
    else out += ch;
  }
  return out + '"';
}

/**
 * Свой проход по тексту: комментарии и границы строковых литералов.
 * Правила разбора строк повторяют лексер (в том числе счёт скобок внутри ${…}),
 * иначе форматтер увидел бы комментарий там, где его для языка нет.
 */
function scanSource(src: string): Scan {
  const comments: Comment[] = [];
  const strings = new Map<number, number>();
  let line = 1;
  let i = 0;

  const lineStartOf = (pos: number): number => {
    let s = pos;
    while (s > 0 && src[s - 1] !== '\n') s--;
    return s;
  };

  while (i < src.length) {
    const c = src[i]!;

    if (c === '\n') { line++; i++; continue; }

    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      const own = src.slice(lineStartOf(start), start).trim() === '';
      comments.push({ start, line, own, text: src.slice(start, i).trimEnd() });
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      const startLine = line;
      i += 2;
      let nesting = 1;
      while (i < src.length && nesting > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { nesting++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { nesting--; i += 2; continue; }
        if (src[i] === '\n') line++;
        i++;
      }
      const own = src.slice(lineStartOf(start), start).trim() === '';
      comments.push({ start, line: startLine, own, text: src.slice(start, i) });
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i++;
      for (;;) {
        if (i >= src.length) break;
        const ch = src[i]!;
        if (ch === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue; }
        if (ch === c) { i++; break; }
        if (ch === '\n') line++;
        if (ch === '$' && src[i + 1] === '{') {
          i += 2;
          let braces = 1;
          while (i < src.length) {
            const d = src[i]!;
            if (d === '\n') line++;
            // Внутри вставки может быть своя строка, а в ней — фигурные скобки.
            // Считать их за скобки вставки значит оборвать литерал посреди.
            if (d === '"' || d === "'" || d === '`') {
              i++;
              while (i < src.length) {
                const e = src[i]!;
                if (e === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue; }
                if (e === '\n') line++;
                i++;
                if (e === d) break;
              }
              continue;
            }
            if (d === '{') braces++;
            if (d === '}') { braces--; if (braces === 0) { i++; break; } }
            i++;
          }
          continue;
        }
        i++;
      }
      strings.set(start, i);
      continue;
    }

    i++;
  }

  return { comments, strings };
}

// ---- приоритеты выражений ------------------------------------------------
// Числа повторяют лестницу парсера: чем больше, тем крепче связывает.
const P_LOWEST = 1;      // присваивание и лямбда-стрелка
const P_TERNARY = 2;
const P_NULLISH = 3;
const P_OR = 4;
const P_AND = 5;
const P_EQUALITY = 6;
const P_COMPARE = 7;
const P_RANGE = 8;
const P_ADD = 9;
const P_MUL = 10;
const P_UNARY = 11;
const P_POWER = 12;
const P_POSTFIX = 13;
const P_PRIMARY = 14;

const BINARY_PREC: Record<string, number> = {
  '==': P_EQUALITY, '!=': P_EQUALITY,
  '<': P_COMPARE, '<=': P_COMPARE, '>': P_COMPARE, '>=': P_COMPARE,
  '+': P_ADD, '-': P_ADD,
  '*': P_MUL, '/': P_MUL, '%': P_MUL,
  '^': P_POWER,
};

const LOGICAL_PREC: Record<string, number> = {
  '??': P_NULLISH, '||': P_OR, 'or': P_OR, '&&': P_AND, 'and': P_AND,
};

/** Записывается ли функция стрелкой: `x -> тело`, `(a, b) -> тело`. */
function isArrow(n: Expr & { kind: 'Fn' }): boolean {
  if (n.name !== null) return false;
  if (n.params.some((p) => p.def !== null)) return false;
  if (n.body.length !== 1) return false;
  const only = n.body[0]!;
  return only.kind === 'Return' && only.value !== null;
}

function precedence(n: Expr): number {
  switch (n.kind) {
    case 'Assign': return P_LOWEST;
    case 'Fn': return isArrow(n) ? P_LOWEST : P_PRIMARY;
    case 'Ternary': return P_TERNARY;
    case 'Logical': return LOGICAL_PREC[n.op] ?? P_NULLISH;
    case 'Binary': return BINARY_PREC[n.op] ?? P_ADD;
    case 'Range': return P_RANGE;
    case 'Unary': return P_UNARY;
    case 'Call': case 'Get': case 'Index': return P_POSTFIX;
    default: return P_PRIMARY;
  }
}

/** Ширина самой длинной строки текста; первая строка стоит в колонке col. */
function widthOf(text: string, col: number): number {
  const lines = text.split('\n');
  let max = col + lines[0]!.length;
  for (let i = 1; i < lines.length; i++) max = Math.max(max, lines[i]!.length);
  return max;
}

/** Колонка, в которой окажется курсор после текста, начатого в колонке col. */
function endCol(text: string, col: number): number {
  const nl = text.lastIndexOf('\n');
  return nl === -1 ? col + text.length : text.length - nl - 1;
}

class Formatter {
  private src: string;
  private srcLines: string[];
  private lineStarts: number[];
  private comments: Comment[];
  private strings: Map<number, number>;
  /** Смещение лексемы-числа → её исходная запись (0xFF, 1_000, 1e3). */
  private numbers = new Map<number, string>();
  private tokens: Token[];
  /** Смещение лексемы → её номер в потоке. */
  private tokenAt = new Map<number, number>();
  /** Смещение «{» → смещение парной «}». */
  private braces = new Map<number, number>();

  private out: string[] = [];
  private ind = 0;
  /** Номер следующего ещё не напечатанного комментария. */
  private ci = 0;
  /** Пустая строка, которую требует правило оформления, а не исходник. */
  private forcedBlank = false;
  /** Последняя строка вывода закончилась комментарием «//» — дописывать в неё нельзя. */
  private lineComment = false;
  /** В только что напечатанном выражении встретилось тело в фигурных скобках. */
  private hasBlockBody = false;
  /**
   * Больше нуля — идёт примерка: текст, возможно, будет выброшен, поэтому
   * комментарии в этом проходе не расходуются. Иначе примерка съедала бы их
   * и в окончательный вывод они уже не попали бы.
   */
  private silent = 0;
  /**
   * Больше нуля — мы внутри заголовка if/while/for, где «{» занято телом блока.
   * Повторяет noMapLiteral парсера: словарь здесь печатается в скобках.
   */
  private noMap = 0;

  constructor(src: string, file: string) {
    this.src = src;
    this.srcLines = src.split('\n');
    this.lineStarts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') this.lineStarts.push(i + 1);

    const scan = scanSource(src);
    this.comments = scan.comments;
    this.strings = scan.strings;

    this.tokens = tokenize(src, file);
    const stack: number[] = [];
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      const off = this.offset(t.span);
      this.tokenAt.set(off, i);
      if (t.type === 'NUMBER') this.numbers.set(off, t.lexeme);
      if (t.type === 'LBRACE') stack.push(off);
      if (t.type === 'RBRACE') { const open = stack.pop(); if (open !== undefined) this.braces.set(open, off); }
    }
  }

  // ---- работа с исходником ------------------------------------------------

  private offset(span: Span): number {
    return (this.lineStarts[span.line - 1] ?? 0) + span.col - 1;
  }

  private lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Была ли в исходнике пустая строка прямо над строкой line. */
  private blankBefore(line: number): boolean {
    return line >= 2 && (this.srcLines[line - 2] ?? '').trim() === '';
  }

  /**
   * Границы блока, который начинается после заголовка со смещения from:
   * первая «{» на нулевой глубине круглых и квадратных скобок и парная ей «}».
   * Стрелка на том же уровне означает тело-выражение — блока нет.
   */
  private blockAt(from: number): { open: number; close: number } | null {
    const start = this.tokenAt.get(from);
    if (start === undefined) return null;
    let depth = 0;
    for (let i = start; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (t.type === 'LPAREN' || t.type === 'LBRACKET') depth++;
      else if (t.type === 'RPAREN' || t.type === 'RBRACKET') depth--;
      else if (depth <= 0 && t.type === 'ARROW') return null;
      else if (depth <= 0 && t.type === 'LBRACE') {
        const open = this.offset(t.span);
        const close = this.braces.get(open);
        return close === undefined ? null : { open, close };
      } else if (t.type === 'EOF') return null;
    }
    return null;
  }

  /** Тело блока по смещению его «{» (для if/while/for оно лежит в span узла Block). */
  private closeOfBrace(open: number): number {
    return this.braces.get(open) ?? -1;
  }

  /**
   * Блок ветки try: первая «catch» или «finally» после закрывающей скобки
   * предыдущей ветки. Искать с этого места безопасно — всё, что вложено внутрь
   * предыдущей ветки, осталось позади.
   */
  private clauseBlockAt(prevClose: number, word: 'CATCH' | 'FINALLY'): { open: number; close: number } | null {
    const start = this.tokenAt.get(prevClose);
    if (start === undefined) return null;
    for (let i = start; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (t.type === word) return this.blockAt(this.offset(t.span));
      if (t.type === 'EOF') return null;
    }
    return null;
  }

  /**
   * Смещения имён полей структуры в исходнике — в AST у полей позиции нет,
   * а без неё комментарий к полю некуда привязать.
   */
  private fieldOffsets(open: number, close: number): Map<string, number> {
    const found = new Map<string, number>();
    const start = this.tokenAt.get(open);
    if (start === undefined) return found;
    let depth = 0;
    for (let i = start + 1; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      const off = this.offset(t.span);
      if (off >= close || t.type === 'EOF') break;
      if (t.type === 'LPAREN' || t.type === 'LBRACKET' || t.type === 'LBRACE') { depth++; continue; }
      if (t.type === 'RPAREN' || t.type === 'RBRACKET' || t.type === 'RBRACE') { depth--; continue; }
      if (depth !== 0) continue;
      if (t.type === 'FN') {
        // Метод: перепрыгиваем через его тело целиком.
        const block = this.blockAt(off);
        if (!block) break;
        const after = this.tokenAt.get(block.close);
        if (after === undefined) break;
        i = after;
        continue;
      }
      if (t.type === 'IDENT') {
        if (!found.has(String(t.value))) found.set(String(t.value), off);
        // Дальше идёт либо «= значение», либо конец описания поля;
        // всё до разделителя пропускаем, чтобы имена изнутри значения не считались полями.
        let d = 0;
        for (i++; i < this.tokens.length; i++) {
          const u = this.tokens[i]!;
          if (u.type === 'LPAREN' || u.type === 'LBRACKET' || u.type === 'LBRACE') d++;
          else if (u.type === 'RPAREN' || u.type === 'RBRACKET') d--;
          else if (u.type === 'RBRACE') { if (d === 0) break; d--; }
          else if (d === 0 && (u.type === 'NEWLINE' || u.type === 'COMMA' || u.type === 'SEMI')) break;
          else if (u.type === 'EOF') break;
        }
      }
    }
    return found;
  }

  // ---- вывод --------------------------------------------------------------

  private push(text: string): void {
    this.out.push(text === '' ? '' : INDENT.repeat(this.ind) + text);
    this.lineComment = text.startsWith('//');
  }

  private appendToLast(text: string): void {
    if (this.out.length === 0) { this.push(text); return; }
    this.out[this.out.length - 1] += text;
  }

  /** Пустая строка перед следующей строкой вывода, если её требует правило или исходник. */
  private blank(srcLine: number | null): void {
    const forced = this.forcedBlank;
    this.forcedBlank = false;
    if (this.out.length === 0) return;
    const last = this.out[this.out.length - 1]!;
    if (last === '') return;
    // Сразу после открывающей скобки блока пустая строка не нужна.
    if (last.trimEnd().endsWith('{')) return;
    if (forced || (srcLine !== null && this.blankBefore(srcLine))) this.out.push('');
  }

  private hasCommentBefore(limit: number): boolean {
    return this.ci < this.comments.length && this.comments[this.ci]!.start < limit;
  }

  /** Напечатать все комментарии, которые в исходнике стоят до смещения limit. */
  private flush(limit: number): void {
    if (this.silent > 0) return;
    while (this.hasCommentBefore(limit)) {
      const c = this.comments[this.ci++]!;
      const last = this.out[this.out.length - 1];
      // Комментарий после кода приклеивается к последней строке — но не к той,
      // что уже кончается «//»: два комментария слились бы в один.
      if (!c.own && last !== undefined && last !== '' && !this.lineComment) {
        this.appendToLast(' ' + c.text);
        this.lineComment = c.text.startsWith('//');
        continue;
      }
      this.blank(c.line);
      this.push(c.text);
    }
  }

  // ---- инструкции ---------------------------------------------------------

  format(program: Program): string {
    this.stmtList(program, Number.MAX_SAFE_INTEGER, true);
    while (this.out.length > 0 && this.out[this.out.length - 1] === '') this.out.pop();
    return this.out.length === 0 ? '' : this.out.join('\n') + '\n';
  }

  private stmtList(list: Stmt[], limit: number, top: boolean): void {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (i > 0 && top && (isDeclaration(s) || isDeclaration(list[i - 1]!))) this.forcedBlank = true;
      this.flush(this.offset(s.span));
      this.blank(s.span.line);
      this.stmt(s);
    }
    this.flush(limit);
  }

  /** Тело в фигурных скобках: заголовок + «{», содержимое, «}» своей строкой. */
  private body(header: string, body: Stmt[], close: number, allowInline: boolean): void {
    const open = header === '' ? '{' : header + ' {';
    if (allowInline && body.length === 0 && !this.hasCommentBefore(close)) {
      this.push(open + '}');
      return;
    }
    // Тело из одной простой инструкции остаётся на строке заголовка, если влезает.
    // Иначе `if n % 3 == 0 { out += "Fizz" }` растягивался бы на три строки, а такой
    // форматтер к своему же коду никто не применит.
    if (allowInline && body.length === 1 && inlinable(body[0]!) && !this.hasCommentBefore(close)) {
      const mark = this.out.length;
      this.stmt(body[0]!);
      const produced = this.out.slice(mark);
      this.out.length = mark;
      if (produced.length === 1 && !produced[0]!.includes('\n')) {
        const line = open + ' ' + produced[0]!.trimStart() + ' }';
        if (widthOf(INDENT.repeat(this.ind) + line, 0) <= WIDTH) {
          this.push(line);
          return;
        }
      }
    }
    this.push(open);
    this.ind++;
    this.stmtList(body, close, false);
    this.ind--;
    this.push('}');
  }

  private stmt(s: Stmt): void {
    switch (s.kind) {
      case 'VarDecl': {
        const prefix = `${s.mutable ? 'let' : 'const'} ${s.name} = `;
        this.push(prefix + this.expr(s.init, P_LOWEST, this.column(prefix.length), this.ind));
        return;
      }

      case 'ExprStmt': {
        const text = this.statementExpr(s.expr);
        this.push(text);
        return;
      }

      case 'Return': {
        if (s.value === null) { this.push('return'); return; }
        this.push('return ' + this.expr(s.value, P_LOWEST, this.column('return '.length), this.ind));
        return;
      }

      case 'Break': this.push('break'); return;
      case 'Continue': this.push('continue'); return;
      case 'Import': {
        if (s.names === null) { this.push(`import ${quote(s.path)} as ${s.alias}`); return; }
        // Список имён переносится по тем же правилам, что список значений:
        // одной строкой, пока влезает, иначе с заполнением строк — имена
        // коротки и однородны, столбец из них читается хуже.
        const prefix = `import ${quote(s.path)} as `;
        const names = s.names;
        this.push(prefix + this.group(
          '{', '}', names.length,
          (k) => {
            const n = names[k]!;
            return n.alias === n.name ? n.name : `${n.name} as ${n.alias}`;
          },
          this.column(prefix.length), this.ind, false, true,
        ));
        return;
      }

      case 'Block': {
        const close = this.closeOfBrace(this.offset(s.span));
        this.body('', s.body, close, false);
        return;
      }

      case 'If': this.ifStmt(s, false); return;

      case 'While': {
        const head = 'while ' + this.headerExpr(s.cond, this.column('while '.length));
        this.body(head, blockBody(s.body), this.closeOfBrace(this.offset(s.body.span)), true);
        return;
      }

      case 'For': {
        const prefix = `for ${s.name} in `;
        const head = prefix + this.headerExpr(s.iterable, this.column(prefix.length));
        this.body(head, blockBody(s.body), this.closeOfBrace(this.offset(s.body.span)), true);
        return;
      }

      case 'Try': {
        const block = this.blockAt(this.offset(s.span));
        this.body('try', s.body, block ? block.close : -1, false);
        // Каждая следующая ветка ищется от «}» предыдущей — и она же пишется
        // на строке этой «}», как «else» после «if».
        let prevClose = block ? block.close : -1;
        if (s.handler !== null) {
          const handler = prevClose >= 0 ? this.clauseBlockAt(prevClose, 'CATCH') : null;
          this.appendToLast(s.param === null ? ' catch {' : ` catch ${s.param} {`);
          this.ind++;
          this.stmtList(s.handler, handler ? handler.close : -1, false);
          this.ind--;
          this.push('}');
          prevClose = handler ? handler.close : -1;
        }
        if (s.finalizer !== null) {
          const fin = prevClose >= 0 ? this.clauseBlockAt(prevClose, 'FINALLY') : null;
          this.appendToLast(' finally {');
          this.ind++;
          this.stmtList(s.finalizer, fin ? fin.close : -1, false);
          this.ind--;
          this.push('}');
        }
        return;
      }

      case 'FnDecl': {
        const block = this.blockAt(this.offset(s.span));
        const head = `fn ${s.name}` + this.params(s.params, this.column(3 + s.name.length));
        this.body(head, s.body, block ? block.close : -1, true);
        return;
      }

      case 'StructDecl': {
        this.structDecl(s);
        return;
      }
    }
  }

  private ifStmt(s: Stmt & { kind: 'If' }, chained: boolean): void {
    const prefix = chained ? ' else if ' : 'if ';
    const cond = this.headerExpr(s.cond, this.column(prefix.length));
    const inline = s.else === null;
    const thenClose = this.closeOfBrace(this.offset(s.then.span));

    if (chained) {
      const open = 'else if ' + cond + ' {';
      if (inline && blockBody(s.then).length === 0 && !this.hasCommentBefore(thenClose)) {
        this.appendToLast(' ' + open + '}');
      } else {
        this.appendToLast(' ' + open);
        this.ind++;
        this.stmtList(blockBody(s.then), thenClose, false);
        this.ind--;
        this.push('}');
      }
    } else {
      this.body('if ' + cond, blockBody(s.then), thenClose, inline);
    }

    if (s.else === null) return;
    if (s.else.kind === 'If') { this.ifStmt(s.else, true); return; }

    const elseClose = this.closeOfBrace(this.offset(s.else.span));
    this.appendToLast(' else {');
    this.ind++;
    this.stmtList(blockBody(s.else), elseClose, false);
    this.ind--;
    this.push('}');
  }

  private structDecl(s: Stmt & { kind: 'StructDecl' }): void {
    const block = this.blockAt(this.offset(s.span));
    const close = block ? block.close : -1;
    const offsets = block ? this.fieldOffsets(block.open, block.close) : new Map<string, number>();

    if (s.fields.length === 0 && s.methods.length === 0 && !this.hasCommentBefore(close)) {
      this.push(`struct ${s.name} {}`);
      return;
    }

    // Структура из одних полей — часто просто узел дерева (`struct Num { value }`),
    // и раскладывать такое объявление в четыре строки незачем.
    if (s.methods.length === 0 && !this.hasCommentBefore(close)) {
      const fields = s.fields.map((f) => this.param(f, 0)).join(', ');
      const line = `struct ${s.name} { ${fields} }`;
      if (!line.includes('\n') && widthOf(INDENT.repeat(this.ind) + line, 0) <= WIDTH) {
        this.push(line);
        return;
      }
    }

    this.push(`struct ${s.name} {`);
    this.ind++;

    for (const f of s.fields) {
      const off = offsets.get(f.name);
      if (off !== undefined) { this.flush(off); this.blank(this.lineOf(off)); }
      this.push(this.param(f, this.column(0)));
    }

    for (let i = 0; i < s.methods.length; i++) {
      const m = s.methods[i]!;
      if (i > 0 || s.fields.length > 0) this.forcedBlank = true;
      this.flush(this.offset(m.span));
      this.blank(m.span.line);
      const mBlock = this.blockAt(this.offset(m.span));
      const head = `fn ${m.name}` + this.params(m.params, this.column(3 + m.name.length));
      this.body(head, m.body, mBlock ? mBlock.close : -1, true);
    }

    this.flush(close);
    this.ind--;
    this.push('}');
  }

  // ---- выражения ----------------------------------------------------------

  private column(extra: number): number {
    return this.ind * INDENT.length + extra;
  }

  /**
   * Выражение целой инструкцией. Если запись начинается с «{» или с «fn имя»,
   * её приходится брать в скобки: иначе парсер прочитает начало блока
   * или объявление функции.
   */
  private statementExpr(e: Expr): string {
    this.silent++;
    const probe = this.expr(e, P_LOWEST, this.column(0), this.ind);
    this.silent--;
    if (probe.startsWith('{') || /^fn [A-Za-z_À-ɏЀ-ӿ]/.test(probe)) {
      return '(' + this.expr(e, P_LOWEST, this.column(1), this.ind) + ')';
    }
    return this.expr(e, P_LOWEST, this.column(0), this.ind);
  }

  /**
   * Выражение в заголовке if/while/for. Здесь «{» занято телом блока, поэтому
   * любой словарь внутри заголовка обязан быть в скобках — ровно как считает
   * парсер своим noMapLiteral. Внутри «(…)» и «[…]» запрет снимается.
   */
  private headerExpr(e: Expr, col: number): string {
    this.noMap++;
    try {
      return this.expr(e, P_LOWEST, col, this.ind);
    } finally {
      this.noMap--;
    }
  }

  /** Отрисовать то, что окажется внутри скобок: там словарь снова однозначен. */
  private inBrackets<T>(render: () => T): T {
    const saved = this.noMap;
    this.noMap = 0;
    try {
      return render();
    } finally {
      this.noMap = saved;
    }
  }

  private expr(e: Expr, min: number, col: number, ind: number, flat = false): string {
    const parens = precedence(e) < min;
    if (!parens) return this.exprRaw(e, col, ind, flat);
    return '(' + this.inBrackets(() => this.exprRaw(e, col + 1, ind, flat)) + ')';
  }

  /**
   * Список в скобках: одной строкой, если влезает, иначе по элементу на строку
   * с висячей запятой. Решение зависит только от дерева и отступа, поэтому
   * повторное форматирование ничего не меняет.
   */
  private group(
    open: string,
    close: string,
    count: number,
    item: (k: number, col: number, ind: number, flat: boolean) => string,
    col: number,
    ind: number,
    flat: boolean,
    allowFill = false,
  ): string {
    // Примерка одной строкой идёт вхолостую (silent): её текст может быть
    // выброшен, а комментарии тратятся только на окончательном проходе.
    const savedBlock = this.hasBlockBody;
    this.hasBlockBody = false;
    this.silent++;
    const parts: string[] = [];
    this.inBrackets(() => {
      for (let k = 0; k < count; k++) parts.push(item(k, 0, ind, true));
    });
    this.silent--;
    // Тело в фигурных скобках внутри элемента ломает список, даже если тот
    // формально «влезает»: перенос по элементу читается, каша из скобок — нет.
    // Единственный элемент — исключение: висячая скобка `f(fn(a, b) { … })` привычна.
    const blocky = this.hasBlockBody && count > 1;
    this.hasBlockBody = savedBlock || this.hasBlockBody;

    if (flat || count === 0 || (!blocky && widthOf(open + parts.join(', ') + close, col) <= WIDTH)) {
      const final: string[] = [];
      this.inBrackets(() => {
        for (let k = 0; k < count; k++) final.push(item(k, 0, ind, true));
      });
      return open + final.join(', ') + close;
    }

    const inner = INDENT.repeat(ind + 1);

    // Список коротких однородных значений заполняет строку, а не растягивается
    // в столбец: таблица из тридцати чисел по строке на число не читается вовсе.
    const fill = allowFill && count > 4
      && parts.every((part) => !part.includes('\n') && part.length <= FILL_ITEM);
    if (fill) {
      const filled: string[] = [];
      this.inBrackets(() => {
        let line = inner;
        for (let k = 0; k < count; k++) {
          const piece = item(k, line.length, ind + 1, true) + ',';
          // Первый элемент строки кладётся всегда: иначе слишком длинный элемент
          // породил бы пустую строку, и перенос повторялся бы бесконечно.
          if (line !== inner && widthOf(line + ' ' + piece, 0) > WIDTH) {
            filled.push(line);
            line = inner;
          }
          line += (line === inner ? '' : ' ') + piece;
        }
        if (line !== inner) filled.push(line);
      });
      return open + '\n' + filled.join('\n') + '\n' + INDENT.repeat(ind) + close;
    }

    const lines: string[] = [];
    this.inBrackets(() => {
      for (let k = 0; k < count; k++) lines.push(inner + item(k, inner.length, ind + 1, false) + ',');
    });
    return open + '\n' + lines.join('\n') + '\n' + INDENT.repeat(ind) + close;
  }

  private params(list: Param[], col: number): string {
    return this.group('(', ')', list.length, (k, c, i) => this.param(list[k]!, c, i), col, this.ind, false);
  }

  private param(p: Param, col: number, ind = this.ind): string {
    if (p.def === null) return p.name;
    const prefix = `${p.name} = `;
    return prefix + this.expr(p.def, P_LOWEST, col + prefix.length, ind);
  }

  private exprRaw(e: Expr, col: number, ind: number, flat: boolean): string {
    switch (e.kind) {
      case 'Number': return this.numbers.get(this.offset(e.span)) ?? String(e.value);
      case 'Bool': return e.value ? 'true' : 'false';
      case 'Nil': return 'nil';
      case 'Ident': return e.name;
      case 'Str': return this.strLiteral(e);
      case 'Template': return this.template(e, col, ind);

      case 'List':
        return this.group('[', ']', e.items.length,
          (k, c, i, f) => this.expr(e.items[k]!, P_LOWEST, c, i, f), col, ind, flat, true);

      case 'Map': {
        if (this.noMap > 0) {
          return '(' + this.inBrackets(() => this.exprRaw(e, col + 1, ind, flat)) + ')';
        }
        return this.group('{', '}', e.entries.length, (k, c, i, f) => {
          const entry = e.entries[k]!;
          const key = this.mapKey(entry.key, c, i, f);
          return key + ': ' + this.expr(entry.value, P_LOWEST, c + key.length + 2, i, f);
        }, col, ind, flat);
      }

      case 'Unary':
        return e.op + this.expr(e.right, P_UNARY, col + 1, ind, flat);

      case 'Binary': {
        const p = BINARY_PREC[e.op] ?? P_ADD;
        // Степень правоассоциативна и связывает крепче унарного минуса:
        // слева от неё нужен постфикс, справа — унарное выражение.
        const leftMin = e.op === '^' ? P_POSTFIX : p;
        const rightMin = e.op === '^' ? P_UNARY : p + 1;
        const left = this.expr(e.left, leftMin, col, ind, flat);
        const mid = ` ${e.op} `;
        return left + mid + this.expr(e.right, rightMin, endCol(left, col) + mid.length, ind, flat);
      }

      case 'Logical': {
        const p = LOGICAL_PREC[e.op] ?? P_NULLISH;
        const left = this.expr(e.left, p, col, ind, flat);
        // Словесные синонимы приводятся к знакам: «not» до форматтера всё равно
        // не доживает (лексер отдаёт «!»), и держать половину синонимов странно.
        const op = e.op === 'and' ? '&&' : e.op === 'or' ? '||' : e.op;
        const mid = ` ${op} `;
        return left + mid + this.expr(e.right, p + 1, endCol(left, col) + mid.length, ind, flat);
      }

      case 'Ternary': {
        const cond = this.expr(e.cond, P_NULLISH, col, ind, flat);
        const then = this.expr(e.then, P_TERNARY, endCol(cond, col) + 3, ind, flat);
        const alt = this.expr(e.else, P_TERNARY, endCol(then, col) + 3, ind, flat);
        return `${cond} ? ${then} : ${alt}`;
      }

      case 'Range': {
        // Диапазон пишется вплотную: 0..10 — это литерал, а не действие над числами.
        const start = this.expr(e.start, P_ADD, col, ind, flat);
        return start + '..' + this.expr(e.end, P_ADD, endCol(start, col) + 2, ind, flat);
      }

      case 'Assign': {
        // `x = x + 1` в `x += 1` не переписывается: это разные деревья и разное
        // поведение. `a[i()] += 1` считает индекс один раз, `a[i()] = a[i()] + 1` — два.
        // Форматтер выравнивает запись, а не меняет смысл.
        const target = this.expr(e.target, P_POSTFIX, col, ind, flat);
        const mid = e.op === null ? ' = ' : ` ${e.op}= `;
        return target + mid + this.expr(e.value, P_LOWEST, endCol(target, col) + mid.length, ind, flat);
      }

      case 'Get':
        return this.expr(e.object, P_POSTFIX, col, ind, flat) + '.' + e.name;

      case 'Index': {
        const obj = this.expr(e.object, P_POSTFIX, col, ind, flat);
        const index = this.inBrackets(() => this.expr(e.index, P_LOWEST, endCol(obj, col) + 1, ind, flat));
        return obj + '[' + index + ']';
      }

      case 'Call': {
        const callee = this.expr(e.callee, P_POSTFIX, col, ind, flat);
        const args = this.group('(', ')', e.args.length,
          (k, c, i, f) => this.expr(e.args[k]!, P_LOWEST, c, i, f), endCol(callee, col), ind, flat);
        return callee + args;
      }

      case 'Fn': return this.fnExpr(e, col, ind, flat);
    }
  }

  /** Функция-значение: стрелкой, если это позволяет форма, иначе полной записью. */
  private fnExpr(e: Expr & { kind: 'Fn' }, col: number, ind: number, flat: boolean): string {
    const block = this.blockAt(this.offset(e.span));
    // Внутри тела есть комментарий — тело остаётся телом: сжав его в стрелку,
    // форматтер вытолкнул бы комментарий из функции наружу.
    const keeps = block !== null
      && this.ci < this.comments.length
      && this.comments[this.ci]!.start > block.open
      && this.comments[this.ci]!.start < block.close;

    if (!keeps && isArrow(e)) {
      const only = e.body[0]! as Stmt & { kind: 'Return' };
      const head = e.params.length === 1
        ? e.params[0]!.name + ' -> '
        : this.params(e.params, col) + ' -> ';
      return head + this.expr(only.value!, P_LOWEST, endCol(head, col), ind, flat);
    }

    const name = e.name === null ? '' : ' ' + e.name;
    const head = 'fn' + name + this.params(e.params, col + 2 + name.length);
    if (e.body.length === 0 && !keeps) return head + ' {}';

    // Тело-блок внутри выражения печатается своими строками: «{» на строке
    // заголовка, «}» — на своей, содержимое с отступом на уровень глубже.
    this.hasBlockBody = true;
    const saved = this.out;
    const savedInd = this.ind;
    this.out = [];
    this.ind = ind + 1;
    this.stmtList(e.body, block ? block.close : -1, false);
    const lines = this.out;
    this.out = saved;
    this.ind = savedInd;
    return head + ' {\n' + lines.join('\n') + '\n' + INDENT.repeat(ind) + '}';
  }

  private mapKey(key: Expr, col: number, ind: number, flat: boolean): string {
    if (key.kind === 'Str') {
      if (isBareKey(key.value)) return key.value;
      return this.strLiteral(key);
    }
    if (key.kind === 'Number' || key.kind === 'Bool') return this.exprRaw(key, col, ind, flat);
    return '[' + this.expr(key, P_LOWEST, col + 1, ind, flat) + ']';
  }

  /** Строка переносится из исходника как есть — вместе с кавычками и экранированием. */
  private strLiteral(e: Expr & { kind: 'Str' }): string {
    const start = this.offset(e.span);
    const end = this.strings.get(start);
    if (end === undefined) return quote(e.value);
    return this.src.slice(start, end);
  }

  private template(e: Expr & { kind: 'Template' }, col: number, ind: number): string {
    const start = this.offset(e.span);
    const end = this.strings.get(start);
    if (end !== undefined) return this.src.slice(start, end);
    // Запасной путь: собрать литерал заново. Сюда попасть можно, только если
    // позиция потерялась, — вставки при этом печатаются каноническим видом.
    let out = '"';
    for (const p of e.parts) {
      if ('text' in p) out += quote(p.text).slice(1, -1);
      else out += '${' + this.expr(p.expr, P_LOWEST, col, ind, true) + '}';
    }
    return out + '"';
  }
}

/** Объявление верхнего уровня, которое отделяется пустой строкой от соседей. */
function isDeclaration(s: Stmt): boolean {
  return s.kind === 'FnDecl' || s.kind === 'StructDecl';
}

/** Тело if/while/for парсер всегда заворачивает в Block. */
function blockBody(s: Stmt): Stmt[] {
  return s.kind === 'Block' ? s.body : [s];
}

/**
 * Комментарии исходника по порядку. Форматтер раскладывает их сам, а тестам
 * этот список нужен, чтобы сверить: до форматирования и после он один и тот же,
 * то есть ни один комментарий не пропал.
 */
export function sourceComments(source: string): string[] {
  return scanSource(source).comments.map((c) => c.text);
}

/**
 * Канонический вид программы. Ошибки разбора летят наружу как есть:
 * форматировать сломанный код нельзя — можно только испортить.
 */
export function format(source: string, file = '<input>'): string {
  const program = parse(tokenize(source, file), file);
  return new Formatter(source, file).format(program);
}
