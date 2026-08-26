import { join } from 'node:path';
import type { Expr, ImportName, Param, Program, Stmt } from './ast.ts';
import { SableError, runtimeError, type Span } from './errors.ts';
import {
  Environment, UNSET, makeShape,
  constAssign, redeclared,
  type Shape,
} from './environment.ts';
import { ModuleLoader } from './modules.ts';
import { findMethodEntry, getMethod, installGlobals, methodNames, repeatText, type MethodEntry } from './stdlib.ts';
import {
  SableModule, NativeFn, SableFunction, SableRange, StructDef, StructInstance,
  type CompiledFn,
  asMapKey, charAt, charLength, equals, isCallable, repr, toStr, truthy, typeName,
  type MapKey, type Value,
} from './values.ts';

/**
 * Управляющие сигналы. `execute` возвращает их значением, а не бросает исключением:
 * бросок в V8 стоит ~200 нс, и на программе с 500 тысячами `return` это половина
 * всего времени вызовов (замер bench/calls). Возвращаемое число не стоит ничего.
 *
 * Значение `return` кладётся в `returnValue`: сигнал остаётся числом без выделения
 * объекта, а прочитать значение успевает тот же вызов, который увидел RETURN.
 */
const NORMAL = 0;
const RETURN = 1;
const BREAK = 2;
const CONTINUE = 3;
type Signal = 0 | 1 | 2 | 3;

/** Скомпилированное выражение: даёт значение в переданной области видимости. */
type ExprFn = (env: Environment) => Value;
/** Скомпилированная инструкция: даёт код сигнала — обычный ход, return, break, continue. */
type StmtFn = (env: Environment) => Signal;

/** Одно объявление в лексической области: имя и можно ли его менять. */
type Decl = { name: string; mutable: boolean };

/** Найденное имя: сколько областей подняться и какой слот внутри. */
type Resolved = { depth: number; slot: number; mutable: boolean };

/**
 * Имена, объявляемые прямо в этом списке инструкций.
 *
 * Внутрь вложенных областей заходить нельзя и не нужно: тела `if`, `while`,
 * `for`, `try` и голые блоки — это всегда `Block`, у которого своя область,
 * а тела функций и структур компилируются отдельно.
 */
function declsOf(body: Stmt[], out: Decl[]): Decl[] {
  for (let i = 0; i < body.length; i++) {
    const s = body[i]!;
    if (s.kind === 'VarDecl') out.push({ name: s.name, mutable: s.mutable });
    else if (s.kind === 'FnDecl' || s.kind === 'StructDecl') out.push({ name: s.name, mutable: false });
    else if (s.kind === 'Import') {
      // Выборочный импорт объявляет столько имён, сколько перечислено, —
      // для области видимости это обычные объявления, просто без «const».
      if (s.names !== null) for (const n of s.names) out.push({ name: n.alias, mutable: false });
      else out.push({ name: s.alias, mutable: false });
    }
  }
  return out;
}

/** Подняться на нужное число областей вверх; глубина 0 разобрана при компиляции. */
function envUp(env: Environment, depth: number): Environment {
  let e = env;
  for (let i = 0; i < depth; i++) e = e.parent!;
  return e;
}

/**
 * Запись в слот. Пустой слот означает, что объявление ещё не выполнялось, —
 * тогда присваивание идёт наружу по имени, как ходило раньше: там имя может
 * оказаться объявленным, а если нет — прозвучит прежнее «нельзя присвоить
 * необъявленному». Изменяемость слота известна с компиляции.
 */
function store(
  from: Environment, owner: Environment,
  slot: number, v: Value, mutable: boolean, name: string, span: Span,
): void {
  if (owner.slots[slot] === UNSET) { from.assign(name, v, span); return; }
  if (!mutable) throw constAssign(name, span);
  owner.slots[slot] = v;
}

/**
 * `break`/`continue` внутри функции обрабатываются значением, но вырваться за
 * границу вызова значением они не могут — вызов сидит внутри выражения. Такой
 * (странный, но давний) случай по-прежнему летит исключением: `fn f() { break }`,
 * позванная из цикла, прерывает цикл вызывающего.
 */

/**
 * Предел глубины вызовов. Стоит заметно ниже реального стека Node (~1100 вызовов sable),
 * чтобы пользователь всегда видел понятное сообщение, а не срыв стека JS.
 * Поднимается через SABLE_MAX_DEPTH вместе с `node --stack-size=...`.
 */
const MAX_DEPTH = Number(process.env.SABLE_MAX_DEPTH) || 900;

/** Предел длины списка: за ним JS бросает свой RangeError с чужим сообщением. */
const MAX_LIST = 50_000_000;

export type Host = {
  /** Куда уходит print. Подменяется в тестах и REPL. */
  write: (text: string) => void;
};

export class Interpreter {
  /** Встроенные имена. Отдельная область, чтобы `let sum = 0` затенял `sum`, а не падал. */
  builtins: Environment;
  globals: Environment;
  /**
   * Глубина вызовов. Раньше здесь лежал массив кадров, но содержимое кадров никто
   * не читал — в отчёт об ошибке имена попадают из `callValue`. Счётчик даёт то же
   * самое без выделения объекта на каждый вызов.
   */
  private depth = 0;
  /** Значение последнего `return` — читается сразу после сигнала RETURN. */
  private returnValue: Value = null;
  host: Host;
  private modules = new ModuleLoader();
  /** Позиция последнего break/continue — нужна, если он вырвался туда, где цикла нет. */
  private signalSpan: Span | null = null;
  /** Абсолютный путь к файлу, который выполняется сейчас — от него считаются пути import. */
  private currentFile: string;
  /**
   * Стек лексических областей — живёт только на время компиляции.
   * Пустой стек означает «мы на верхнем уровне»: глобальная область, верхний
   * уровень модуля и REPL пополняются во время выполнения, там имена по-прежнему
   * ищутся по имени. Компиляция всегда заканчивается до выполнения, поэтому к
   * моменту `import` (а значит и вложенной компиляции модуля) стек снова пуст.
   */
  private scopes: Shape[] = [];

  constructor(host: Host = { write: (t) => process.stdout.write(t) }, entryFile = join(process.cwd(), '<input>')) {
    this.builtins = new Environment(null, true);
    this.globals = new Environment(this.builtins);
    this.host = host;
    this.currentFile = entryFile;
    installGlobals(this);
  }

  /**
   * Выполнить подключаемый файл в собственной области видимости
   * и отдать объявленные в нём имена наружу.
   */
  runModule(program: Program, file: string): Map<string, Value> {
    const moduleEnv = new Environment(this.globals);
    const prevFile = this.currentFile;
    this.currentFile = file;
    let sig: Signal;
    try {
      // Компиляция идёт при том же currentFile, что и выполнение: `import`
      // внутри модуля считает путь от папки модуля, а не главного файла.
      sig = this.compileBlock(program)(moduleEnv);
    } finally {
      this.currentFile = prevFile;
    }
    if (sig !== NORMAL) throw escaped(sig, this.signalSpan);
    return moduleEnv.ownEntries();
  }

  run(program: Program): void {
    try {
      const sig = this.compileBlock(program)(this.globals);
      if (sig !== NORMAL) throw escaped(sig, this.signalSpan);
    } catch (e) {
      throw this.decorate(e);
    }
  }

  /** Выполнить программу и вернуть значение последнего выражения — для REPL. */
  runInteractive(program: Program): Value {
    let last: Value = null;
    try {
      for (const stmt of program) {
        if (stmt.kind === 'ExprStmt') {
          last = this.compileExpr(stmt.expr)(this.globals);
        } else {
          const sig = this.compileStmt(stmt)(this.globals);
          if (sig !== NORMAL) throw escaped(sig, this.signalSpan);
          last = null;
        }
      }
    } catch (e) {
      throw this.decorate(e);
    }
    return last;
  }

  /**
   * Срыв стека JS — не сбой рантайма, а слишком глубокое выражение в программе.
   * Но не всякий RangeError об этом: «строка слишком длинная» — тоже RangeError,
   * и выдавать её за глубокую вложенность значит врать пользователю.
   */
  decorate(e: unknown): unknown {
    if (e instanceof RangeError) {
      return /call stack/i.test(e.message)
        ? runtimeError('слишком глубокая вложенность вычислений')
        : runtimeError(`слишком большое значение: ${e.message}`);
    }
    return e;
  }

  // ---- компиляция ---------------------------------------------------------
  //
  // Каждый узел дерева один раз превращается в замыкание. Раньше на каждое
  // вычисление уходил разбор узла в switch; теперь разбор случается однажды,
  // а в горячем цикле остаётся только вызов готовой функции.

  // ---- разрешение имён ----------------------------------------------------
  //
  // Слоты выделяются заранее, по полному списку объявлений области, — поэтому
  // замыкание, созданное выше объявления, всё равно попадёт в нужный слот, а
  // обращение до заполнения даст ту же ошибку «имя не определено», что и раньше.

  /**
   * Открыть лексическую область. Область без единого объявления не заводится
   * вовсе: ей не в чем хранить имена, а лишний объект на каждый виток `while`
   * или вход в `if` стоит дороже всего остального в теле.
   */
  private pushScope(decls: Decl[]): Shape | null {
    if (decls.length === 0) return null;
    const names: string[] = [];
    const mutables: boolean[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < decls.length; i++) {
      const d = decls[i]!;
      // Имя, объявленное дважды, делит один слот: второе объявление увидит его
      // заполненным и скажет «уже объявлено» — ровно там же, где говорило раньше.
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      names.push(d.name);
      mutables.push(d.mutable);
    }
    const shape = makeShape(names, mutables);
    this.scopes.push(shape);
    return shape;
  }

  /** Где лежит имя: (глубина, слот). null — имя глобальное, встроенное или из модуля. */
  private resolve(name: string): Resolved | null {
    const scopes = this.scopes;
    for (let d = scopes.length - 1, depth = 0; d >= 0; d--, depth++) {
      const slot = scopes[d]!.index.get(name);
      if (slot !== undefined) return { depth, slot, mutable: scopes[d]!.mutables[slot]! };
    }
    return null;
  }

  /** Слот объявления в текущей области; -1 — верхний уровень, объявляем по имени. */
  private declSlot(name: string): number {
    const scopes = this.scopes;
    if (scopes.length === 0) return -1;
    return scopes[scopes.length - 1]!.index.get(name) ?? -1;
  }

  private compileBlock(body: Stmt[]): StmtFn {
    const fns: StmtFn[] = new Array(body.length);
    for (let i = 0; i < body.length; i++) fns[i] = this.compileStmt(body[i]!);

    if (fns.length === 0) return () => NORMAL;
    if (fns.length === 1) return fns[0]!;
    return (env) => {
      for (let i = 0; i < fns.length; i++) {
        const sig = fns[i]!(env);
        if (sig !== NORMAL) return sig;
      }
      return NORMAL;
    };
  }

  /**
   * Тело функции и её значения по умолчанию — общие для всех её экземпляров.
   *
   * Область вызова у функции одна на всё: `self`, параметры и объявления тела
   * лежат в ней рядом — так же, как раньше их складывал `define`.
   */
  private compileFn(params: Param[], body: Stmt[], hasSelf = false): CompiledFn {
    const decls: Decl[] = [];
    if (hasSelf) decls.push({ name: 'self', mutable: false });
    for (let i = 0; i < params.length; i++) decls.push({ name: params[i]!.name, mutable: true });
    declsOf(body, decls);

    const shape = this.pushScope(decls);
    // Значения по умолчанию считаются в области вызова — они вправе ссылаться
    // на другие параметры, поэтому компилируются внутри той же области.
    const defaults: Array<ExprFn | null> = params.map((p) => (p.def ? this.compileExpr(p.def) : null));
    const paramSlots = shape === null ? [] : params.map((p) => shape.index.get(p.name)!);
    const run = this.compileBlock(body);
    if (shape !== null) this.scopes.pop();

    return { run, defaults, shape, paramSlots, selfSlot: hasSelf ? shape!.index.get('self')! : -1 };
  }

  private compileStmt(stmt: Stmt): StmtFn {
    switch (stmt.kind) {
      case 'ExprStmt': {
        const value = this.compileExpr(stmt.expr);
        return (env) => { value(env); return NORMAL; };
      }

      case 'VarDecl': {
        const init = this.compileExpr(stmt.init);
        const { name, mutable, span } = stmt;
        const slot = this.declSlot(name);
        if (slot < 0) {
          return (env) => { env.define(name, init(env), mutable, span); return NORMAL; };
        }
        return (env) => {
          // Порядок тот же, что был у define: сначала считается значение,
          // и только потом выясняется, что имя уже занято.
          const v = init(env);
          if (env.slots[slot] !== UNSET) throw redeclared(name, span);
          env.slots[slot] = v;
          return NORMAL;
        };
      }

      case 'If': {
        const cond = this.compileExpr(stmt.cond);
        const then = this.compileStmt(stmt.then);
        if (stmt.else === null) {
          return (env) => (truthy(cond(env)) ? then(env) : NORMAL);
        }
        const alt = this.compileStmt(stmt.else);
        return (env) => (truthy(cond(env)) ? then(env) : alt(env));
      }

      case 'Block': {
        const shape = this.pushScope(declsOf(stmt.body, []));
        const body = this.compileBlock(stmt.body);
        // Блок, который ничего не объявляет, выполняется прямо во внешней области:
        // складывать в неё всё равно нечего. Тело `while` или `if` — как раз такой
        // блок, и раньше на каждый его виток уходил лишний объект.
        if (shape === null) return body;
        this.scopes.pop();
        return (env) => body(new Environment(env, false, shape));
      }

      case 'Return': {
        if (stmt.value === null) return () => { this.returnValue = null; return RETURN; };
        const value = this.compileExpr(stmt.value);
        return (env) => { this.returnValue = value(env); return RETURN; };
      }

      case 'While': {
        const cond = this.compileExpr(stmt.cond);
        const body = this.compileStmt(stmt.body);
        return (env) => {
          while (truthy(cond(env))) {
            const sig = body(env);
            if (sig === BREAK) break;
            if (sig === RETURN) return RETURN;
          }
          return NORMAL;
        };
      }

      case 'For':
        return this.compileFor(stmt);

      case 'Try':
        return this.compileTry(stmt);

      case 'Break': {
        const span = stmt.span;
        return () => { this.signalSpan = span; return BREAK; };
      }

      case 'Continue': {
        const span = stmt.span;
        return () => { this.signalSpan = span; return CONTINUE; };
      }

      case 'FnDecl': {
        const code = this.compileFn(stmt.params, stmt.body);
        const { name, params, span } = stmt;
        const slot = this.declSlot(name);
        if (slot < 0) {
          return (env) => {
            env.define(name, new SableFunction(name, params, code, env), false, span);
            return NORMAL;
          };
        }
        return (env) => {
          if (env.slots[slot] !== UNSET) throw redeclared(name, span);
          env.slots[slot] = new SableFunction(name, params, code, env);
          return NORMAL;
        };
      }

      case 'StructDecl': {
        const { name, fields, span } = stmt;
        // Значения полей по умолчанию считаются не там, где структура объявлена,
        // а в отдельной области-потомке глобальной, которая наполняется полями по
        // ходу дела (см. construct). Область растущая, поэтому на время их
        // компиляции лексический стек откладывается — имена там ищутся по имени.
        const outer = this.scopes;
        this.scopes = [];
        const fieldDefaults: Array<ExprFn | null> = fields.map((f) => (f.def ? this.compileExpr(f.def) : null));
        this.scopes = outer;

        const methods = stmt.methods.map((m) => ({
          name: m.name,
          params: m.params,
          code: this.compileFn(m.params, m.body, true),
        }));
        const slot = this.declSlot(name);
        const make = (env: Environment): StructDef => {
          const table = new Map<string, SableFunction>();
          const def = new StructDef(name, fields, table, fieldDefaults);
          for (const m of methods) {
            table.set(m.name, new SableFunction(`${name}.${m.name}`, m.params, m.code, env));
          }
          return def;
        };
        if (slot < 0) {
          return (env) => { env.define(name, make(env), false, span); return NORMAL; };
        }
        return (env) => {
          if (env.slots[slot] !== UNSET) throw redeclared(name, span);
          env.slots[slot] = make(env);
          return NORMAL;
        };
      }

      case 'Import': {
        const { path, span } = stmt;
        if (stmt.names !== null) return this.compileSelectiveImport(path, stmt.names, span);

        const alias = stmt.alias;
        const slot = this.declSlot(alias);
        if (slot < 0) {
          return (env) => {
            env.define(alias, this.modules.load(this, path, this.currentFile, alias, span), false, span);
            return NORMAL;
          };
        }
        return (env) => {
          const mod = this.modules.load(this, path, this.currentFile, alias, span);
          if (env.slots[slot] !== UNSET) throw redeclared(alias, span);
          env.slots[slot] = mod;
          return NORMAL;
        };
      }
    }
  }

  /**
   * Выборочный импорт: модуль выполняется тем же загрузчиком (а значит, ровно
   * один раз), но в область ложатся только перечисленные имена — само
   * пространство имён модуля здесь не заводится вовсе.
   */
  private compileSelectiveImport(path: string, names: ImportName[], span: Span): StmtFn {
    // Слоты известны с компиляции — как у любого другого объявления области.
    const slots = names.map((n) => this.declSlot(n.alias));
    return (env) => {
      const exports = this.modules.loadExports(this, path, this.currentFile, span);
      for (let i = 0; i < names.length; i++) {
        const n = names[i]!;
        // Значений undefined в языке нет: пустой ответ означает, что имени в модуле нет.
        const value = exports.get(n.name);
        if (value === undefined) throw missingExport(path, n.name, exports, n.span);
        const slot = slots[i]!;
        if (slot < 0) {
          env.define(n.alias, value, false, n.span);
          continue;
        }
        if (env.slots[slot] !== UNSET) throw redeclared(n.alias, n.span);
        env.slots[slot] = value;
      }
      return NORMAL;
    };
  }

  private compileFor(stmt: Extract<Stmt, { kind: 'For' }>): StmtFn {
    // Последовательность считается снаружи цикла — до того, как открыта его область.
    const iterable = this.compileExpr(stmt.iterable);
    const inner = (stmt.body as Extract<Stmt, { kind: 'Block' }>).body;
    const { name, span } = stmt;

    // Переменная цикла и объявления тела живут в одной области — так же, как
    // и раньше: тело `for` своей области никогда не заводило.
    const shape = this.pushScope(declsOf(inner, [{ name, mutable: true }]))!;
    const body = this.compileBlock(inner);
    this.scopes.pop();
    const varSlot = shape.index.get(name)!;

    // Своя область на каждый виток: замыкания внутри цикла ловят разные значения.
    const step = (outer: Environment, item: Value): Signal => {
      const env = new Environment(outer, false, shape);
      env.slots[varSlot] = item;
      return body(env);
    };

    return (env) => {
      const seq = iterable(env);

      // Диапазон перебирается счётчиком: ради `for i in 0..1000000` незачем
      // сначала строить миллион элементов в памяти.
      if (seq instanceof SableRange) {
        for (let i = seq.start; i < seq.end; i++) {
          const sig = step(env, i);
          if (sig === BREAK) break;
          if (sig === RETURN) return RETURN;
        }
        return NORMAL;
      }

      const items = this.iterate(seq, span);
      for (let k = 0; k < items.length; k++) {
        const sig = step(env, items[k]!);
        if (sig === BREAK) break;
        if (sig === RETURN) return RETURN;
      }
      return NORMAL;
    };
  }

  /**
   * try/catch перехватывает только ошибки выполнения самой программы.
   * Сигналы return/break/continue проходят насквозь: иначе `return` изнутри try
   * перестал бы выходить из функции.
   */
  private compileTry(stmt: Extract<Stmt, { kind: 'Try' }>): StmtFn {
    const bodyShape = this.pushScope(declsOf(stmt.body, []));
    const body = this.compileBlock(stmt.body);
    if (bodyShape !== null) this.scopes.pop();

    const param = stmt.param;
    const handlerShape = this.pushScope(declsOf(stmt.handler, param ? [{ name: param, mutable: false }] : []));
    const handler = this.compileBlock(stmt.handler);
    if (handlerShape !== null) this.scopes.pop();
    const paramSlot = param && handlerShape ? handlerShape.index.get(param)! : -1;

    return (env) => {
      const depthBefore = this.depth;
      try {
        return body(bodyShape === null ? env : new Environment(env, false, bodyShape));
      } catch (raw) {
        // Срыв стека JS — это тоже ошибка выполнения программы, и справочник
        // обещает, что ошибки выполнения ловятся. Без перевода она пролетала
        // мимо catch, и программа умирала внутри try.
        const e = raw instanceof RangeError ? this.decorate(raw) : raw;
        if (!(e instanceof SableError) || e.stage !== 'runtime') throw e;
        // Кадры вызовов, оборванных ошибкой, снимаем — обработчик выполняется на своём уровне.
        this.depth = depthBefore;
        const caught = handlerShape === null ? env : new Environment(env, false, handlerShape);
        if (paramSlot >= 0) caught.slots[paramSlot] = describeError(e);
        return handler(caught);
      }
    };
  }

  /**
   * Что вообще можно перебрать в for. Список копируется: изменение исходного
   * списка внутри цикла не должно менять то, что цикл ещё пройдёт.
   * Диапазон здесь тоже разворачивается, но цикл до этого не доходит —
   * он идёт по диапазону счётчиком.
   */
  iterate(seq: Value, span: Span): Value[] {
    if (Array.isArray(seq)) return [...seq];
    if (seq instanceof SableRange) return seq.toList();
    if (typeof seq === 'string') return [...seq];
    if (seq instanceof Map) return [...seq.keys()] as Value[];
    throw runtimeError(`по значению типа ${typeName(seq)} нельзя пройти циклом for`, span);
  }

  // ---- выражения ----------------------------------------------------------

  private compileExpr(expr: Expr): ExprFn {
    switch (expr.kind) {
      case 'Ident': {
        const { name, span } = expr;
        const found = this.resolve(name);
        // Имя не из лексической области — глобальное, встроенное или из модуля:
        // такие области растут по ходу выполнения, там поиск остаётся по имени.
        // Но начинать его можно сразу снаружи всех открытых лексических областей.
        if (found === null) {
          const up = this.scopes.length;
          if (up === 0) return (env) => env.get(name, span);
          return (env) => env.outerGet(up, name, span);
        }

        // Слот выделен заранее, но заполняется только объявлением. Пока он пуст,
        // имени здесь ещё нет — и поиск обязан пойти наружу ровно так, как ходил
        // до разбора по слотам: снаружи имя может быть объявлено и раньше.
        // Если и там его нет, `get` скажет то же самое, что говорил всегда.
        const slot = found.slot;
        switch (found.depth) {
          case 0: return (env) => {
            const v = env.slots[slot];
            return v === UNSET ? env.get(name, span) : v as Value;
          };
          case 1: return (env) => {
            const v = env.parent!.slots[slot];
            return v === UNSET ? env.get(name, span) : v as Value;
          };
          default: {
            const depth = found.depth;
            return (env) => {
              const v = envUp(env, depth).slots[slot];
              return v === UNSET ? env.get(name, span) : v as Value;
            };
          }
        }
      }

      case 'Number': {
        const value = expr.value;
        return () => value;
      }

      case 'Str': {
        const value = expr.value;
        return () => value;
      }

      case 'Bool': {
        const value = expr.value;
        return () => value;
      }

      case 'Nil':
        return () => null;

      case 'Binary': {
        const left = this.compileExpr(expr.left);
        const right = this.compileExpr(expr.right);
        const { op, span } = expr;
        return (env) => this.binary(op, left(env), right(env), span);
      }

      case 'Call':
        return this.compileCall(expr);

      case 'Get': {
        const object = this.compileExpr(expr.object);
        const { name, span } = expr;
        return (env) => this.getMember(object(env), name, span);
      }

      case 'Index': {
        const object = this.compileExpr(expr.object);
        const index = this.compileExpr(expr.index);
        const span = expr.span;
        return (env) => this.getIndex(object(env), index(env), span);
      }

      case 'Assign':
        return this.compileAssign(expr);

      case 'Template': {
        const parts = expr.parts.map((part) =>
          'text' in part ? part.text : this.compileExpr(part.expr));
        return (env) => {
          let out = '';
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i]!;
            out += typeof part === 'string' ? part : toStr(part(env));
          }
          return out;
        };
      }

      case 'List': {
        const items = expr.items.map((item) => this.compileExpr(item));
        return (env) => {
          const out: Value[] = new Array(items.length);
          for (let i = 0; i < items.length; i++) out[i] = items[i]!(env);
          return out;
        };
      }

      case 'Map': {
        const entries = expr.entries.map((e) => ({
          key: this.compileExpr(e.key),
          value: this.compileExpr(e.value),
        }));
        const span = expr.span;
        return (env) => {
          const map = new Map<MapKey, Value>();
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i]!;
            map.set(asMapKey(e.key(env), span), e.value(env));
          }
          return map;
        };
      }

      case 'Fn': {
        const code = this.compileFn(expr.params, expr.body);
        const { name, params } = expr;
        return (env) => new SableFunction(name, params, code, env);
      }

      case 'Range': {
        const start = this.compileExpr(expr.start);
        const end = this.compileExpr(expr.end);
        const span = expr.span;
        return (env) => this.makeRange(start(env), end(env), span);
      }

      case 'Unary': {
        const right = this.compileExpr(expr.right);
        const span = expr.span;
        if (expr.op === '!') return (env) => !truthy(right(env));
        return (env) => -this.numberOperand(right(env), 'операнд унарного минуса', span);
      }

      case 'Logical': {
        const left = this.compileExpr(expr.left);
        const right = this.compileExpr(expr.right);
        if (expr.op === '??') return (env) => { const l = left(env); return l === null ? right(env) : l; };
        if (expr.op === '&&' || expr.op === 'and') {
          return (env) => { const l = left(env); return truthy(l) ? right(env) : l; };
        }
        return (env) => { const l = left(env); return truthy(l) ? l : right(env); };
      }

      case 'Ternary': {
        const cond = this.compileExpr(expr.cond);
        const then = this.compileExpr(expr.then);
        const alt = this.compileExpr(expr.else);
        return (env) => (truthy(cond(env)) ? then(env) : alt(env));
      }
    }
  }

  private compileCall(expr: Extract<Expr, { kind: 'Call' }>): ExprFn {
    const args = expr.args.map((a) => this.compileExpr(a));
    const span = expr.span;
    const evalArgs = (env: Environment): Value[] => {
      const out: Value[] = new Array(args.length);
      for (let i = 0; i < args.length; i++) out[i] = args[i]!(env);
      return out;
    };

    // `значение.метод(...)` — самый частый вызов в коде. Идём напрямую к реализации,
    // не создавая на каждое обращение объект-функцию, который живёт до конца вызова.
    const target = expr.callee;
    if (target.kind === 'Get') {
      const object = this.compileExpr(target.object);
      const name = target.name;
      const memberSpan = target.span;
      return (env) => {
        const obj = object(env);
        const entry = fastMethodOf(obj, name);
        if (entry) {
          const values = evalArgs(env);
          this.checkArity(`${typeName(obj)}.${name}`, values.length, entry.min, entry.max, span);
          return entry.impl(obj as never, values, span, this);
        }
        return this.callValue(this.getMember(obj, name, memberSpan), evalArgs(env), span, name);
      };
    }

    const callee = this.compileExpr(target);
    const shown = this.calleeName(target);
    return (env) => this.callValue(callee(env), evalArgs(env), span, shown);
  }

  private makeRange(startValue: Value, endValue: Value, span: Span): SableRange {
    const start = this.numberOperand(startValue, 'начало диапазона', span);
    const end = this.numberOperand(endValue, 'конец диапазона', span);
    // За пределом точных целых прибавление единицы перестаёт двигать счётчик:
    // такой цикл не закончится не «когда-нибудь», а никогда. Бесконечность — тот же случай.
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw runtimeError('границы диапазона должны быть обычными числами', span);
    }
    if (Math.abs(start) > Number.MAX_SAFE_INTEGER || Math.abs(end) > Number.MAX_SAFE_INTEGER) {
      throw runtimeError(
        `границы диапазона больше ${Number.MAX_SAFE_INTEGER} — за этим пределом ` +
        'счётчик перестаёт расти, и цикл не закончится никогда',
        span,
      );
    }
    return new SableRange(start, end);
  }

  private calleeName(callee: Expr): string {
    if (callee.kind === 'Ident') return callee.name;
    if (callee.kind === 'Get') return callee.name;
    return 'анонимная функция';
  }

  /**
   * Части цели вычисляются ровно один раз. Разворот «a[i] += v» в
   * «a[i] = a[i] + v» считал бы i дважды: при побочном эффекте в индексе
   * читали бы одну ячейку, а писали в другую.
   */
  private compileAssign(expr: Extract<Expr, { kind: 'Assign' }>): ExprFn {
    const target = expr.target;
    const op = expr.op;
    const value = this.compileExpr(expr.value);
    const span = expr.span;

    if (target.kind === 'Ident') {
      const { name, span: nameSpan } = target;
      const found = this.resolve(name);
      if (found !== null) {
        const { depth, slot, mutable } = found;
        // Изменяемость слота известна на этапе компиляции — искать её на каждом
        // присваивании больше не нужно, остаётся проверка «слот уже заполнен».
        if (op === null) {
          if (depth === 0) {
            return (env) => { const v = value(env); store(env, env, slot, v, mutable, name, span); return v; };
          }
          return (env) => {
            const v = value(env);
            store(env, envUp(env, depth), slot, v, mutable, name, span);
            return v;
          };
        }
        const read = this.compileExpr(target);
        if (depth === 0) {
          return (env) => {
            const v = this.binary(op, read(env), value(env), span);
            store(env, env, slot, v, mutable, name, span);
            return v;
          };
        }
        return (env) => {
          const v = this.binary(op, read(env), value(env), span);
          store(env, envUp(env, depth), slot, v, mutable, name, span);
          return v;
        };
      }

      const up = this.scopes.length;
      if (op === null) {
        if (up === 0) return (env) => { const v = value(env); env.assign(name, v, span); return v; };
        return (env) => { const v = value(env); env.outerAssign(up, name, v, span); return v; };
      }
      if (up === 0) {
        return (env) => {
          const v = this.binary(op, env.get(name, nameSpan), value(env), span);
          env.assign(name, v, span);
          return v;
        };
      }
      return (env) => {
        const v = this.binary(op, env.outerGet(up, name, nameSpan), value(env), span);
        env.outerAssign(up, name, v, span);
        return v;
      };
    }

    if (target.kind === 'Get') {
      const object = this.compileExpr(target.object);
      const { name, span: nameSpan } = target;
      return (env) => {
        const obj = object(env);
        const v = op === null
          ? value(env)
          : this.binary(op, this.getMember(obj, name, nameSpan), value(env), span);

        if (obj instanceof SableModule) {
          throw runtimeError(`имена модуля «${obj.alias}» менять нельзя`, span);
        }
        if (obj instanceof StructInstance) {
          if (!obj.fields.has(name)) {
            throw runtimeError(`у ${obj.def.name} нет поля «${name}»`, span);
          }
          obj.fields.set(name, v);
          return v;
        }
        if (obj instanceof Map) {
          obj.set(name, v);
          return v;
        }
        throw runtimeError(`нельзя присвоить поле «${name}» значению типа ${typeName(obj)}`, span);
      };
    }

    if (target.kind !== 'Index') {
      return () => { throw runtimeError('присваивать можно только переменной, полю или элементу', span); };
    }

    const object = this.compileExpr(target.object);
    const index = this.compileExpr(target.index);
    const indexSpan = target.span;
    return (env) => {
      const obj = object(env);
      const key = index(env);
      const v = op === null
        ? value(env)
        : this.binary(op, this.getIndex(obj, key, indexSpan), value(env), span);

      if (Array.isArray(obj)) {
        obj[this.listIndex(obj, key, span)] = v;
        return v;
      }
      if (obj instanceof Map) {
        obj.set(asMapKey(key, span), v);
        return v;
      }
      if (typeof obj === 'string') {
        throw runtimeError('строки неизменяемы — соберите новую строку вместо записи по индексу', span);
      }
      throw runtimeError(`нельзя присвоить по индексу значению типа ${typeName(obj)}`, span);
    };
  }
  // ---- операции -----------------------------------------------------------

  private numberOperand(v: Value, what: string, span: Span): number {
    if (typeof v !== 'number') throw runtimeError(`${what} должен быть числом, а получен ${typeName(v)}`, span);
    return v;
  }

  private binary(op: string, l: Value, r: Value, span: Span): Value {
    // Два числа — самый частый случай в любой программе. Разбираем его сразу,
    // не проходя разбор типов для строк, списков и структур.
    if (typeof l === 'number' && typeof r === 'number') {
      switch (op) {
        case '+': return finite(l + r, op, span);
        case '-': return finite(l - r, op, span);
        case '*': return finite(l * r, op, span);
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
        case '==': return l === r;
        case '!=': return l !== r;
        case '^': return finite(l ** r, op, span);
        case '/':
          if (r === 0) throw runtimeError('деление на ноль', span);
          return finite(l / r, op, span);
        case '%':
          if (r === 0) throw runtimeError('остаток от деления на ноль', span);
          return finite(l % r, op, span);
      }
    }

    switch (op) {
      case '==': return equals(l, r);
      case '!=': return !equals(l, r);
    }

    if (op === '+') {
      // Два числа сюда не доходят — их разобрал быстрый путь в начале функции.
      // Отдельная ветка для них здесь ещё и обошла бы проверку на переполнение.
      if (typeof l === 'string' && typeof r === 'string') return l + r;
      if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
      if (typeof l === 'string' || typeof r === 'string') {
        throw runtimeError(
          `нельзя сложить ${typeName(l)} и ${typeName(r)} — приведите к строке через str(...) или вставку \${...}`,
          span,
        );
      }
      throw runtimeError(`нельзя сложить ${typeName(l)} и ${typeName(r)}`, span);
    }

    if (op === '*') {
      if (typeof l === 'string' && typeof r === 'number') return this.repeatStr(l, r, span);
      if (typeof l === 'number' && typeof r === 'string') return this.repeatStr(r, l, span);
      if (Array.isArray(l) && typeof r === 'number') {
        const n = this.wholeCount(r, span);
        if (l.length * n > MAX_LIST) {
          throw runtimeError(
            `список из ${l.length * n} элементов слишком велик — предел ${MAX_LIST}`,
            span,
          );
        }
        const out: Value[] = [];
        // Не спредом: он упирается в предел числа аргументов около 125 тысяч,
        // и до честной проверки MAX_LIST дело не доходило — вместо неё
        // выпадало чужое сообщение про вложенность вычислений.
        for (let i = 0; i < n; i++) for (const item of l) out.push(item);
        return out;
      }
    }

    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (typeof l === 'string' && typeof r === 'string') {
        const c = l < r ? -1 : l > r ? 1 : 0;
        return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
      }
    }

    // Сюда доходит только то, где хотя бы один операнд не число: два числа
    // целиком разобраны быстрым путём в начале. Эти два вызова и дают
    // сообщение о неподходящем типе — считать здесь уже нечего.
    this.numberOperand(l, `левый операнд «${op}»`, span);
    this.numberOperand(r, `правый операнд «${op}»`, span);
    throw runtimeError(`неизвестный оператор «${op}»`, span);
  }

  private wholeCount(n: number, span: Span): number {
    if (!Number.isInteger(n) || n < 0) {
      throw runtimeError(`количество повторов должно быть целым неотрицательным числом, а не ${repr(n)}`, span);
    }
    return n;
  }

  private repeatStr(s: string, n: number, span: Span): string {
    return repeatText(s, this.wholeCount(n, span), span);
  }

  // ---- доступ к членам ----------------------------------------------------

  getMember(obj: Value, name: string, span: Span): Value {
    if (obj === null) {
      throw runtimeError(`нельзя обратиться к «${name}» у nil — проверьте значение или используйте «??»`, span);
    }

    if (obj instanceof StructInstance) {
      // Значений undefined в языке нет, поэтому один поиск заменяет пару has + get.
      const field = obj.fields.get(name);
      if (field !== undefined) return field;
      const m = obj.def.methods.get(name);
      if (m) return m.bind(obj);
      throw runtimeError(
        `у ${obj.def.name} нет поля или метода «${name}»${hint(name, [...obj.fields.keys(), ...obj.def.methods.keys()])}`,
        span,
      );
    }

    if (obj instanceof Map) {
      // У словаря данные важнее методов: user.name должен работать всегда.
      const held = obj.get(name);
      if (held !== undefined) return held;
    }

    if (obj instanceof SableModule) {
      const exported = obj.exports.get(name);
      if (exported !== undefined) return exported;
      const near = nearest(name, [...obj.exports.keys()]);
      throw runtimeError(
        `в модуле «${obj.alias}» нет имени «${name}»${near ? ` — возможно, имелось в виду «${near}»` : ''}`,
        span,
      );
    }

    const method = getMethod(this, obj, name, span);
    if (method) return method;

    if (obj instanceof Map) {
      throw runtimeError(
        `в словаре нет ключа «${name}» и нет такого метода` +
        hint(name, [...[...obj.keys()].filter((k) => typeof k === 'string'), ...methodNames(obj)]),
        span,
      );
    }
    throw runtimeError(
      `у значения типа ${typeName(obj)} нет поля или метода «${name}»${hint(name, methodNames(obj))}`,
      span,
    );
  }

  private listIndex(list: Value[], key: Value, span: Span): number {
    if (typeof key !== 'number' || !Number.isInteger(key)) {
      throw runtimeError(`индекс списка должен быть целым числом, а получен ${typeName(key)}`, span);
    }
    // Отрицательный индекс считается с конца: xs[-1] — последний элемент.
    const i = key < 0 ? list.length + key : key;
    if (i < 0 || i >= list.length) {
      throw runtimeError(`индекс ${key} вне списка длиной ${list.length}`, span);
    }
    return i;
  }

  getIndex(obj: Value, key: Value, span: Span): Value {
    if (Array.isArray(obj)) return obj[this.listIndex(obj, key, span)]!;

    if (typeof obj === 'string') {
      if (typeof key !== 'number' || !Number.isInteger(key)) {
        throw runtimeError(`индекс строки должен быть целым числом, а получен ${typeName(key)}`, span);
      }
      const ch = charAt(obj, key);
      if (ch === null) throw runtimeError(`индекс ${key} вне строки длиной ${charLength(obj)}`, span);
      return ch;
    }

    if (obj instanceof Map) {
      const k = asMapKey(key, span);
      // Значений undefined в языке нет, поэтому один поиск заменяет пару has + get.
      const held = obj.get(k);
      if (held === undefined) throw runtimeError(`в словаре нет ключа ${repr(k as Value)}`, span);
      return held;
    }

    if (obj instanceof SableRange) {
      // Считаем элемент, а не разворачиваем диапазон: `(0..1000000000)[0]`
      // иначе съедал бы всю память ради одного числа. Диапазон обещан ленивым,
      // и индексация — единственное место, где это обещание нарушалось.
      if (typeof key !== 'number' || !Number.isInteger(key)) {
        throw runtimeError(`индекс диапазона должен быть целым числом, а получен ${typeName(key)}`, span);
      }
      const size = obj.length;
      const at = key < 0 ? size + key : key;
      if (at < 0 || at >= size) {
        throw runtimeError(`индекс ${key} вне диапазона длиной ${size}`, span);
      }
      return obj.start + at;
    }

    if (obj === null) throw runtimeError('нельзя взять элемент по индексу у nil', span);
    throw runtimeError(`нельзя взять элемент по индексу у значения типа ${typeName(obj)}`, span);
  }

  // ---- вызовы -------------------------------------------------------------

  /**
   * Вызов пользовательского колбэка из стандартной библиотеки.
   * Лишние аргументы (индекс в map/filter) отбрасываются: колбэк вправе взять только то,
   * что ему нужно, а строгая проверка арности остаётся для обычных вызовов.
   */
  callCallback(fn: Value, args: Value[], span: Span, who: string): Value {
    if (fn instanceof SableFunction) return this.callValue(fn, args.slice(0, fn.params.length), span, who);
    if (fn instanceof NativeFn) return this.callValue(fn, args.slice(0, Math.min(args.length, fn.maxArgs)), span, who);
    throw runtimeError(`«${who}» ожидает функцию, а получила ${typeName(fn)}`, span);
  }

  callValue(callee: Value, args: Value[], span: Span, name = 'значение'): Value {
    if (!isCallable(callee)) {
      throw runtimeError(`${typeName(callee)} нельзя вызвать как функцию`, span);
    }

    if (callee instanceof NativeFn) {
      this.checkArity(callee.name, args.length, callee.minArgs, callee.maxArgs, span);
      return callee.impl(args, span);
    }

    if (callee instanceof StructDef) return this.construct(callee, args, span);

    const fn = callee as SableFunction;
    this.checkArity(fn.name ?? name, args.length, fn.required, fn.params.length, span);

    if (this.depth >= MAX_DEPTH) {
      throw runtimeError(
        `слишком глубокая рекурсия: больше ${MAX_DEPTH} вложенных вызовов — ` +
        'проверьте условие выхода или перепишите цикл без рекурсии',
        span,
      );
    }

    const code = fn.code;
    const shape = code.shape;
    // Функции без параметров и объявлений своя область не нужна: складывать в неё
    // нечего, а на каждый вызов это был лишний объект.
    let env = fn.closure;
    if (shape !== null) {
      env = new Environment(fn.closure, false, shape);
      if (code.selfSlot >= 0 && fn.self !== null) env.slots[code.selfSlot] = fn.self;
      this.bindParams(code, args, env);
    }

    this.depth++;
    try {
      const sig = code.run(env) as Signal;
      if (sig === RETURN) {
        const value = this.returnValue;
        this.returnValue = null; // не держим значение живым дольше нужного
        return value;
      }
      // Граница вызова сигнал не пропускает: цикл вызывающего — не «свой» цикл.
      // Раньше break изнутри функции молча прерывал цикл, из которого её позвали,
      // и статическая проверка спорила с рантаймом. Теперь оба говорят одно.
      if (sig !== NORMAL) throw escaped(sig, this.signalSpan);
      return null;
    } catch (e) {
      if (e instanceof SableError && e.stage === 'runtime' && e.trace.length >= 12) e.dropped++;
      if (e instanceof SableError && e.stage === 'runtime' && e.trace.length < 12) {
        e.trace.push({ name: fn.name ?? 'анонимная функция', span });
      }
      throw e;
    } finally {
      this.depth--;
    }
  }

  private bindParams(code: CompiledFn, args: Value[], env: Environment): void {
    const n = args.length;
    const slots = code.paramSlots;
    const defaults = code.defaults;
    for (let i = 0; i < slots.length; i++) {
      // Значение по умолчанию вычисляется в области вызова — оно может ссылаться на другие параметры.
      const fallback = defaults[i];
      env.slots[slots[i]!] = i < n ? args[i]! : fallback ? fallback(env) : null;
    }
  }

  private construct(def: StructDef, args: Value[], span: Span): Value {
    const list = def.fields;
    const n = args.length;
    this.checkArity(def.name, n, def.required, list.length, span);
    const fields = new Map<string, Value>();
    // Область нужна только значениям по умолчанию: они видят уже посчитанные поля.
    // Если аргументов хватило на все поля, ни одно из них не вычисляется.
    const env = n < list.length ? new Environment(this.globals) : null;
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!;
      const fallback = def.fieldDefaults[i];
      const value = i < n ? args[i]! : fallback ? fallback(env!) : null;
      fields.set(f.name, value);
      if (env) env.define(f.name, value, true);
    }
    return new StructInstance(def, fields);
  }

  checkArity(name: string, got: number, min: number, max: number, span: Span): void {
    if (got >= min && got <= max) return;
    const need = min === max ? `${min}`
      : max === Infinity ? `хотя бы ${min}`
      : `от ${min} до ${max}`;
    throw runtimeError(
      `«${name}» ожидает ${need} ${plural(max === Infinity ? min : max)}, а получила ${got}`,
      span,
    );
  }
}

/** Сигнал, дошедший до верха программы, — ошибка исходника. */
function escaped(sig: Signal, span: Span | null = null): unknown {
  if (sig === RETURN) return runtimeError('«return» вне функции', span);
  const word = sig === BREAK ? 'break' : 'continue';
  return runtimeError(
    `«${word}» вне цикла — из функции нельзя прервать цикл, который её вызвал`,
    span,
  );
}

/**
 * Ошибка как значение языка: у неё всегда есть `message`, а `value` хранит то,
 * что передали в error(...) — иначе форма пойманного зависела бы от источника ошибки.
 */
function describeError(e: SableError): Value {
  const map = new Map<MapKey, Value>();
  map.set('message', e.message);
  map.set('value', (e.payload ?? null) as Value);
  map.set('file', e.span?.file ?? '');
  map.set('line', e.span?.line ?? 0);
  map.set('column', e.span?.col ?? 0);
  return map;
}

/**
 * В языке нет бесконечности и «не числа»: раз деление на ноль — ошибка,
 * то и переполнение при умножении или возведении в степень должно быть ошибкой.
 * Иначе inf расползается по программе молча и всплывает где-нибудь в JSON как null.
 */
function finite(n: number, op: string, span: Span): number {
  if (Number.isFinite(n)) return n;
  throw runtimeError(
    Number.isNaN(n)
      ? `результат «${op}» не является числом`
      : `результат «${op}» вышел за пределы представимых чисел`,
    span,
  );
}

/**
 * Метод встроенного типа, к которому можно обратиться напрямую.
 * Структуры, модули и словари сюда не попадают: у них свои правила поиска
 * имени (у словаря данные важнее методов), и ломать их ради скорости нельзя.
 */
function fastMethodOf(obj: Value, name: string): MethodEntry | null {
  if (obj instanceof StructInstance || obj instanceof SableModule || obj instanceof StructDef) return null;
  if (obj instanceof Map && obj.has(name)) return null;
  return findMethodEntry(obj, name);
}

/**
 * Имени нет в модуле. Тот же текст, что и у обращения `модуль.имя`, — иначе
 * одна и та же беда называлась бы двумя разными словами; только вместо
 * псевдонима модуль назван путём: своего имени у него здесь нет.
 */
function missingExport(path: string, name: string, exports: Map<string, Value>, span: Span): unknown {
  const near = nearest(name, [...exports.keys()]);
  return runtimeError(
    `в модуле «${path}» нет имени «${name}»${near ? ` — возможно, имелось в виду «${near}»` : ''}`,
    span,
  );
}

/** Готовая приписка «возможно, имелось в виду» — или пустая строка. */
function hint(name: string, known: string[]): string {
  const near = nearest(name, known);
  return near ? ` — возможно, имелось в виду «${near}»` : '';
}

/** Ближайшее по написанию имя — для подсказки «возможно, имелось в виду». */
function nearest(name: string, known: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const k of known) {
    if (Math.abs(k.length - name.length) > 3) continue;
    let d = 0;
    const a = name.toLowerCase();
    const b = k.toLowerCase();
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0]!;
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j]!;
        prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    d = prev[b.length]!;
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return best && bestDist <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'аргумент';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'аргумента';
  return 'аргументов';
}
