import { lexError, type Span } from './errors.ts';
import { ENDS_STATEMENT, KEYWORDS, type StringPart, type Token, type TokenType } from './token.ts';

const isDigit = (c: string) => c >= '0' && c <= '9';
const isHex = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
// Имена: латиница, кириллица, подчёркивание.
const isIdentStart = (c: string) => /[A-Za-z_À-ɏЀ-ӿ]/.test(c);
// Внутри имени дополнительно разрешён тюркский окина: oʻquvchi, gʻalaba.
// Обычный апостроф сюда не входит намеренно — он занят под строковый литерал.
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c) || /[\u02BB\u02BC\u2018\u2019]/.test(c);

export class Lexer {
  private src: string;
  private file: string;
  private pos = 0;
  private line: number;
  private col: number;
  private tokens: Token[] = [];
  /** Глубина () и [] — внутри них перевод строки незначим. */
  private depth = 0;
  /**
   * Глубина скобок, отложенная на входе в «{». Внутри блока перевод строки снова
   * значим, даже если блок стоит в аргументе вызова: тело функции, записанное
   * в скобках вызова, иначе слиплось бы в одну инструкцию.
   */
  private depthStack: number[] = [];

  constructor(source: string, file = '<input>', startLine = 1, startCol = 1) {
    this.src = source;
    this.file = file;
    this.line = startLine;
    this.col = startCol;
  }

  private here(): Span {
    return { line: this.line, col: this.col, file: this.file };
  }

  private peek(off = 0): string {
    return this.src[this.pos + off] ?? '';
  }

  private advance(): string {
    const c = this.src[this.pos++] ?? '';
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private match(expected: string): boolean {
    if (this.src.startsWith(expected, this.pos)) {
      for (let i = 0; i < expected.length; i++) this.advance();
      return true;
    }
    return false;
  }

  private push(type: TokenType, lexeme: string, span: Span, extra: Partial<Token> = {}): void {
    this.tokens.push({ type, lexeme, span, ...extra });
  }

  /** Перевод строки значим, только если предыдущая лексема могла закончить инструкцию. */
  private pushNewline(span: Span): void {
    if (this.depth > 0) return;
    const prev = this.tokens[this.tokens.length - 1];
    if (!prev || !ENDS_STATEMENT.has(prev.type)) return;
    this.push('NEWLINE', '\\n', span);
  }

  tokenize(): Token[] {
    while (this.pos < this.src.length) this.scanToken();
    this.pushNewline(this.here());
    this.push('EOF', '', this.here());
    return this.tokens;
  }

  private scanToken(): void {
    const span = this.here();
    const c = this.advance();

    switch (c) {
      case ' ': case '\t': case '\r': return;
      case '\n': return this.pushNewline(span);

      case '(': this.depth++; return this.push('LPAREN', c, span);
      case ')': this.depth = Math.max(0, this.depth - 1); return this.push('RPAREN', c, span);
      case '[': this.depth++; return this.push('LBRACKET', c, span);
      case ']': this.depth = Math.max(0, this.depth - 1); return this.push('RBRACKET', c, span);
      case '{':
        this.depthStack.push(this.depth);
        this.depth = 0;
        return this.push('LBRACE', c, span);
      case '}':
        this.depth = this.depthStack.pop() ?? 0;
        return this.push('RBRACE', c, span);
      case ',': return this.push('COMMA', c, span);
      case ':': return this.push('COLON', c, span);
      case ';': return this.push('SEMI', c, span);
      case '^': return this.push('CARET', c, span);
      case '%': return this.push('PERCENT', c, span);
      case '*': return this.match('=') ? this.push('STAR_ASSIGN', '*=', span) : this.push('STAR', c, span);

      case '.':
        if (this.match('.')) return this.push('RANGE', '..', span);
        return this.push('DOT', c, span);

      case '+': return this.match('=') ? this.push('PLUS_ASSIGN', '+=', span) : this.push('PLUS', c, span);
      case '-':
        if (this.match('=')) return this.push('MINUS_ASSIGN', '-=', span);
        if (this.match('>')) return this.push('ARROW', '->', span);
        return this.push('MINUS', c, span);

      case '/':
        if (this.match('/')) {
          while (this.peek() !== '\n' && this.pos < this.src.length) this.advance();
          return;
        }
        if (this.match('*')) return this.blockComment(span);
        return this.match('=') ? this.push('SLASH_ASSIGN', '/=', span) : this.push('SLASH', c, span);

      case '=': return this.match('=') ? this.push('EQ', '==', span) : this.push('ASSIGN', c, span);
      case '!': return this.match('=') ? this.push('NEQ', '!=', span) : this.push('BANG', c, span);
      case '<': return this.match('=') ? this.push('LTE', '<=', span) : this.push('LT', c, span);
      case '>': return this.match('=') ? this.push('GTE', '>=', span) : this.push('GT', c, span);
      case '&':
        if (this.match('&')) return this.push('AND', '&&', span);
        throw lexError('одиночный «&» не является оператором — вы имели в виду «&&»?', span);
      case '|':
        if (this.match('|')) return this.push('OR', '||', span);
        throw lexError('одиночный «|» не является оператором — вы имели в виду «||»?', span);
      case '?':
        if (this.match('?')) return this.push('QQ', '??', span);
        return this.push('QUESTION', '?', span);

      case '"': case "'": case '`': return this.string(c, span);
    }

    if (isDigit(c)) return this.number(c, span);
    if (isIdentStart(c)) return this.identifier(c, span);

    throw lexError(`неизвестный символ «${c}»`, span);
  }

  private blockComment(span: Span): void {
    let nesting = 1;
    while (nesting > 0) {
      if (this.pos >= this.src.length) throw lexError('блочный комментарий не закрыт (ожидалось «*/»)', span);
      if (this.match('/*')) nesting++;
      else if (this.match('*/')) nesting--;
      else this.advance();
    }
  }

  private number(first: string, span: Span): void {
    let raw = first;
    if (first === '0' && (this.peek() === 'x' || this.peek() === 'X')) {
      raw += this.advance();
      while (isHex(this.peek()) || this.peek() === '_') raw += this.advance();
      const value = Number.parseInt(raw.replace(/_/g, ''), 16);
      if (!Number.isFinite(value)) throw lexError(`некорректное или слишком большое шестнадцатеричное число «${raw}»`, span);
      return this.push('NUMBER', raw, span, { value });
    }
    while (isDigit(this.peek()) || this.peek() === '_') raw += this.advance();
    // «1..5» — это диапазон, а не число с точкой: точку берём, только если за ней цифра.
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      raw += this.advance();
      while (isDigit(this.peek()) || this.peek() === '_') raw += this.advance();
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      const save = { pos: this.pos, line: this.line, col: this.col };
      let exp = this.advance();
      if (this.peek() === '+' || this.peek() === '-') exp += this.advance();
      if (isDigit(this.peek())) {
        while (isDigit(this.peek())) exp += this.advance();
        raw += exp;
      } else {
        this.pos = save.pos; this.line = save.line; this.col = save.col;
      }
    }
    const value = Number(raw.replace(/_/g, ''));
    // Не просто NaN: `1e999` даёт inf, а бесконечности в языке нет — иначе она
    // расползлась бы по программе и всплыла в JSON как null.
    if (!Number.isFinite(value)) throw lexError(`число «${raw}» слишком велико для языка`, span);
    this.push('NUMBER', raw, span, { value });
  }

  private identifier(first: string, span: Span): void {
    let raw = first;
    while (isIdentPart(this.peek())) raw += this.advance();
    this.push(KEYWORDS[raw] ?? 'IDENT', raw, span, { value: raw });
  }

  /**
   * Строка с интерполяцией. Текстовые куски собираются здесь,
   * а `${...}` сохраняется как исходник со своей позицией — его разберёт парсер.
   * В обратных кавычках строка может занимать несколько строк исходника.
   */
  private string(quote: string, span: Span): void {
    const multiline = quote === '`';
    const parts: StringPart[] = [];
    let text = '';

    for (;;) {
      if (this.pos >= this.src.length) {
        throw lexError(multiline ? 'строка в обратных кавычках не закрыта' : 'строка не закрыта до конца файла', span);
      }
      if (!multiline && this.peek() === '\n') {
        throw lexError('строка не закрыта до конца строки исходника — для многострочной используйте `обратные кавычки`', span);
      }
      if (this.peek() === quote) { this.advance(); break; }

      if (this.peek() === '\\') {
        this.advance();
        const e = this.advance();
        switch (e) {
          case 'n': text += '\n'; break;
          case 't': text += '\t'; break;
          case 'r': text += '\r'; break;
          case '0': text += '\0'; break;
          case '\\': text += '\\'; break;
          case '$': text += '$'; break;
          case '"': text += '"'; break;
          case "'": text += "'"; break;
          case '`': text += '`'; break;
          case 'u': {
            if (!this.match('{')) throw lexError('после \\u ожидалось «{», например \\u{41}', span);
            let hex = '';
            while (this.peek() !== '}' && this.pos < this.src.length) hex += this.advance();
            if (!this.match('}')) throw lexError('escape \\u{...} не закрыт', span);
            // parseInt глотает хвост: «41zz» дал бы «A» молча. Проверяем запись целиком.
            if (!/^[0-9A-Fa-f]+$/.test(hex)) {
              throw lexError(`некорректный код символа «${hex}» — ожидались шестнадцатеричные цифры`, span);
            }
            const code = Number.parseInt(hex, 16);
            // Верхняя граница Unicode. Без неё String.fromCodePoint бросал свой
            // RangeError, и наружу вылезал стек JavaScript вместо ошибки языка.
            if (code > 0x10FFFF) {
              throw lexError(`код символа «${hex}» больше предельного 10FFFF`, span);
            }
            text += String.fromCodePoint(code);
            break;
          }
          default: throw lexError(`неизвестная escape-последовательность «\\${e}»`, span);
        }
        continue;
      }

      if (this.peek() === '$' && this.peek(1) === '{') {
        if (text) { parts.push({ kind: 'text', text }); text = ''; }
        this.advance(); this.advance();
        const exprSpan = this.here();
        let source = '';
        let braces = 1;
        for (;;) {
          if (this.pos >= this.src.length) throw lexError('вставка ${...} не закрыта', exprSpan);
          const ch = this.peek();

          // Внутри вставки может быть своя строка, а в ней — фигурные скобки.
          // Считать их за скобки вставки значит оборвать её посреди литерала.
          if (ch === '"' || ch === "'" || ch === '`') {
            source += this.advance();
            for (;;) {
              if (this.pos >= this.src.length) throw lexError('строка внутри вставки ${...} не закрыта', exprSpan);
              const inner = this.peek();
              if (inner === '\n' && ch !== '`') {
                throw lexError('строка внутри вставки ${...} не закрыта до конца строки', exprSpan);
              }
              if (inner === '\\') { source += this.advance(); source += this.advance(); continue; }
              source += this.advance();
              if (inner === ch) break;
            }
            continue;
          }

          if (ch === '{') braces++;
          if (ch === '}') { braces--; if (braces === 0) { this.advance(); break; } }
          source += this.advance();
        }
        if (source.trim() === '') throw lexError('пустая вставка ${} — внутри нужно выражение', exprSpan);
        parts.push({ kind: 'expr', source, span: exprSpan });
        continue;
      }

      text += this.advance();
    }

    if (text || parts.length === 0) parts.push({ kind: 'text', text });
    const onlyText = parts.every((p) => p.kind === 'text');
    this.push('STRING', quote + '...' + quote, span, {
      value: onlyText ? parts.map((p) => (p as { text: string }).text).join('') : undefined,
      parts: onlyText ? undefined : parts,
    });
  }
}

export const tokenize = (source: string, file = '<input>'): Token[] => new Lexer(source, file).tokenize();
