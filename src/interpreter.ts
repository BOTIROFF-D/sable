import { join } from 'node:path';
import type { Expr, Param, Program, Stmt } from './ast.ts';
import { DbgoError, runtimeError, type Span } from './errors.ts';
import { Environment } from './environment.ts';
import { ModuleLoader } from './modules.ts';
import { findMethodEntry, getMethod, installGlobals, repeatText, type MethodEntry } from './stdlib.ts';
import {
  DbgoModule, NativeFn, DbgoFunction, DbgoRange, StructDef, StructInstance,
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

/**
 * `break`/`continue` внутри функции обрабатываются значением, но вырваться за
 * границу вызова значением они не могут — вызов сидит внутри выражения. Такой
 * (странный, но давний) случай по-прежнему летит исключением: `fn f() { break }`,
 * позванная из цикла, прерывает цикл вызывающего.
 */

/**
 * Предел глубины вызовов. Стоит заметно ниже реального стека Node (~1100 вызовов dbgo),
 * чтобы пользователь всегда видел понятное сообщение, а не срыв стека JS.
 * Поднимается через DBGO_MAX_DEPTH вместе с `node --stack-size=...`.
 */
const MAX_DEPTH = Number(process.env.DBGO_MAX_DEPTH) || 900;

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
  private decorate(e: unknown): unknown {
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

  /** Тело функции и её значения по умолчанию — общие для всех её экземпляров. */
  private compileFn(params: Param[], body: Stmt[]): CompiledFn {
    const defaults: Array<ExprFn | null> = params.map((p) => (p.def ? this.compileExpr(p.def) : null));
    return { run: this.compileBlock(body), defaults };
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
        return (env) => { env.define(name, init(env), mutable, span); return NORMAL; };
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
        const body = this.compileBlock(stmt.body);
        return (env) => body(new Environment(env));
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
        return (env) => {
          env.define(name, new DbgoFunction(name, params, code, env), false, span);
          return NORMAL;
        };
      }

      case 'StructDecl': {
        const { name, fields, span } = stmt;
        const fieldDefaults: Array<ExprFn | null> = fields.map((f) => (f.def ? this.compileExpr(f.def) : null));
        const methods = stmt.methods.map((m) => ({
          name: m.name,
          params: m.params,
          code: this.compileFn(m.params, m.body),
        }));
        return (env) => {
          const table = new Map<string, DbgoFunction>();
          const def = new StructDef(name, fields, table, fieldDefaults);
          for (const m of methods) {
            table.set(m.name, new DbgoFunction(`${name}.${m.name}`, m.params, m.code, env));
          }
          env.define(name, def, false, span);
          return NORMAL;
        };
      }

      case 'Import': {
        const { path, alias, span } = stmt;
        return (env) => {
          env.define(alias, this.modules.load(this, path, this.currentFile, alias, span), false, span);
          return NORMAL;
        };
      }
    }
  }

  private compileFor(stmt: Extract<Stmt, { kind: 'For' }>): StmtFn {
    const iterable = this.compileExpr(stmt.iterable);
    const body = this.compileBlock((stmt.body as Extract<Stmt, { kind: 'Block' }>).body);
    const { name, span } = stmt;

    // Своя область на каждый виток: замыкания внутри цикла ловят разные значения.
    const step = (outer: Environment, item: Value): Signal => {
      const env = new Environment(outer);
      env.define(name, item, true);
      return body(env);
    };

    return (env) => {
      const seq = iterable(env);

      // Диапазон перебирается счётчиком: ради `for i in 0..1000000` незачем
      // сначала строить миллион элементов в памяти.
      if (seq instanceof DbgoRange) {
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
    const body = this.compileBlock(stmt.body);
    const handler = this.compileBlock(stmt.handler);
    const param = stmt.param;

    return (env) => {
      const depthBefore = this.depth;
      try {
        return body(new Environment(env));
      } catch (e) {
        if (!(e instanceof DbgoError) || e.stage !== 'runtime') throw e;
        // Кадры вызовов, оборванных ошибкой, снимаем — обработчик выполняется на своём уровне.
        this.depth = depthBefore;
        const caught = new Environment(env);
        if (param) caught.define(param, describeError(e), false);
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
    if (seq instanceof DbgoRange) return seq.toList();
    if (typeof seq === 'string') return [...seq];
    if (seq instanceof Map) return [...seq.keys()] as Value[];
    throw runtimeError(`по значению типа ${typeName(seq)} нельзя пройти циклом for`, span);
  }

  // ---- выражения ----------------------------------------------------------

  private compileExpr(expr: Expr): ExprFn {
    switch (expr.kind) {
      case 'Ident': {
        const { name, span } = expr;
        return (env) => env.get(name, span);
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
        return (env) => new DbgoFunction(name, params, code, env);
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

  private makeRange(startValue: Value, endValue: Value, span: Span): DbgoRange {
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
    return new DbgoRange(start, end);
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
      if (op === null) {
        return (env) => { const v = value(env); env.assign(name, v, span); return v; };
      }
      return (env) => {
        const v = this.binary(op, env.get(name, nameSpan), value(env), span);
        env.assign(name, v, span);
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

        if (obj instanceof DbgoModule) {
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
      if (typeof l === 'number' && typeof r === 'number') return l + r;
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
        for (let i = 0; i < n; i++) out.push(...l);
        return out;
      }
    }

    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (typeof l === 'string' && typeof r === 'string') {
        const c = l < r ? -1 : l > r ? 1 : 0;
        return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
      }
    }

    const a = this.numberOperand(l, `левый операнд «${op}»`, span);
    const b = this.numberOperand(r, `правый операнд «${op}»`, span);

    switch (op) {
      case '-': return finite(a - b, op, span);
      case '*': return finite(a * b, op, span);
      case '/':
        if (b === 0) throw runtimeError('деление на ноль', span);
        return finite(a / b, op, span);
      case '%':
        if (b === 0) throw runtimeError('остаток от деления на ноль', span);
        return finite(a % b, op, span);
      case '^': return finite(a ** b, op, span);
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
    }
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
      throw runtimeError(`у ${obj.def.name} нет поля или метода «${name}»`, span);
    }

    if (obj instanceof Map) {
      // У словаря данные важнее методов: user.name должен работать всегда.
      const held = obj.get(name);
      if (held !== undefined) return held;
    }

    if (obj instanceof DbgoModule) {
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
      throw runtimeError(`в словаре нет ключа «${name}» и нет такого метода`, span);
    }
    throw runtimeError(`у значения типа ${typeName(obj)} нет поля или метода «${name}»`, span);
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

    if (obj instanceof DbgoRange) {
      const list = obj.toList();
      return list[this.listIndex(list, key, span)]!;
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
    if (fn instanceof DbgoFunction) return this.callValue(fn, args.slice(0, fn.params.length), span, who);
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

    const fn = callee as DbgoFunction;
    this.checkArity(fn.name ?? name, args.length, fn.required, fn.params.length, span);

    if (this.depth >= MAX_DEPTH) {
      throw runtimeError(
        `слишком глубокая рекурсия: больше ${MAX_DEPTH} вложенных вызовов — ` +
        'проверьте условие выхода или перепишите цикл без рекурсии',
        span,
      );
    }

    const env = new Environment(fn.closure);
    if (fn.self) env.define('self', fn.self, false);
    this.bindParams(fn.params, fn.code.defaults, args, env);

    this.depth++;
    try {
      const sig = fn.code.run(env) as Signal;
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
      if (e instanceof DbgoError && e.stage === 'runtime' && e.trace.length < 12) {
        e.trace.push({ name: fn.name ?? 'анонимная функция', span });
      }
      throw e;
    } finally {
      this.depth--;
    }
  }

  private bindParams(
    params: Param[],
    defaults: Array<ExprFn | null>,
    args: Value[],
    env: Environment,
  ): void {
    const n = args.length;
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      // Значение по умолчанию вычисляется в области вызова — оно может ссылаться на другие параметры.
      const fallback = defaults[i];
      const value = i < n ? args[i]! : fallback ? fallback(env) : null;
      env.define(p.name, value, true);
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
function describeError(e: DbgoError): Value {
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
  if (obj instanceof StructInstance || obj instanceof DbgoModule || obj instanceof StructDef) return null;
  if (obj instanceof Map && obj.has(name)) return null;
  return findMethodEntry(obj, name);
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
