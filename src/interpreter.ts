import { join } from 'node:path';
import type { Expr, Param, Program, Stmt } from './ast.ts';
import { DbgoError, runtimeError, type Span } from './errors.ts';
import { Environment } from './environment.ts';
import { ModuleLoader } from './modules.ts';
import { getMethod, installGlobals } from './stdlib.ts';
import {
  DbgoModule, NativeFn, DbgoFunction, DbgoRange, StructDef, StructInstance,
  asMapKey, equals, isCallable, repr, toStr, truthy, typeName,
  type MapKey, type Value,
} from './values.ts';

// Управляющие сигналы: дешевле и проще, чем протаскивать флаги через каждый узел.
class ReturnSignal { value: Value; constructor(v: Value) { this.value = v; } }
class BreakSignal {}
class ContinueSignal {}

/**
 * Предел глубины вызовов. Стоит заметно ниже реального стека Node (~1100 вызовов dbgo),
 * чтобы пользователь всегда видел понятное сообщение, а не срыв стека JS.
 * Поднимается через DBGO_MAX_DEPTH вместе с `node --stack-size=...`.
 */
const MAX_DEPTH = Number(process.env.DBGO_MAX_DEPTH) || 900;

export type Host = {
  /** Куда уходит print. Подменяется в тестах и REPL. */
  write: (text: string) => void;
};

export class Interpreter {
  /** Встроенные имена. Отдельная область, чтобы `let sum = 0` затенял `sum`, а не падал. */
  builtins: Environment;
  globals: Environment;
  private env: Environment;
  private stack: Array<{ name: string; span: Span }> = [];
  host: Host;
  private modules = new ModuleLoader();
  /** Абсолютный путь к файлу, который выполняется сейчас — от него считаются пути import. */
  private currentFile: string;

  constructor(host: Host = { write: (t) => process.stdout.write(t) }, entryFile = join(process.cwd(), '<input>')) {
    this.builtins = new Environment(null, true);
    this.globals = new Environment(this.builtins);
    this.env = this.globals;
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
    try {
      this.executeBlock(program, moduleEnv);
    } finally {
      this.currentFile = prevFile;
    }
    return moduleEnv.ownEntries();
  }

  run(program: Program): void {
    try {
      for (const stmt of program) this.execute(stmt);
    } catch (e) {
      throw this.decorate(e);
    }
  }

  /** Выполнить программу и вернуть значение последнего выражения — для REPL. */
  runInteractive(program: Program): Value {
    let last: Value = null;
    try {
      for (const stmt of program) {
        if (stmt.kind === 'ExprStmt') last = this.evaluate(stmt.expr);
        else { this.execute(stmt); last = null; }
      }
    } catch (e) {
      throw this.decorate(e);
    }
    return last;
  }

  /** Сигналы, вырвавшиеся наружу, — это ошибки исходника, а не сбой рантайма. */
  private decorate(e: unknown): unknown {
    if (e instanceof ReturnSignal) return runtimeError('«return» вне функции');
    if (e instanceof BreakSignal) return runtimeError('«break» вне цикла');
    if (e instanceof ContinueSignal) return runtimeError('«continue» вне цикла');
    if (e instanceof RangeError) return runtimeError('слишком глубокая вложенность вычислений');
    return e;
  }

  // ---- инструкции ---------------------------------------------------------

  private execute(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'Import': {
        const mod = this.modules.load(this, stmt.path, this.currentFile, stmt.alias, stmt.span);
        this.env.define(stmt.alias, mod, false, stmt.span);
        return;
      }

      case 'ExprStmt':
        this.evaluate(stmt.expr);
        return;

      case 'VarDecl':
        this.env.define(stmt.name, this.evaluate(stmt.init), stmt.mutable, stmt.span);
        return;

      case 'FnDecl': {
        const fn = new DbgoFunction(stmt.name, stmt.params, stmt.body, this.env);
        this.env.define(stmt.name, fn, false, stmt.span);
        return;
      }

      case 'StructDecl': {
        const methods = new Map<string, DbgoFunction>();
        const def = new StructDef(stmt.name, stmt.fields, methods);
        for (const m of stmt.methods) {
          methods.set(m.name, new DbgoFunction(`${stmt.name}.${m.name}`, m.params, m.body, this.env));
        }
        this.env.define(stmt.name, def, false, stmt.span);
        return;
      }

      case 'Block':
        this.executeBlock(stmt.body, new Environment(this.env));
        return;

      case 'If':
        if (truthy(this.evaluate(stmt.cond))) this.execute(stmt.then);
        else if (stmt.else) this.execute(stmt.else);
        return;

      case 'While':
        while (truthy(this.evaluate(stmt.cond))) {
          try {
            this.execute(stmt.body);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;

      case 'For':
        return this.executeFor(stmt);

      case 'Try':
        return this.executeTry(stmt);

      case 'Return':
        throw new ReturnSignal(stmt.value ? this.evaluate(stmt.value) : null);

      case 'Break':
        throw new BreakSignal();

      case 'Continue':
        throw new ContinueSignal();
    }
  }

  /**
   * try/catch перехватывает только ошибки выполнения самой программы.
   * Сигналы return/break/continue проходят насквозь: иначе `return` изнутри try
   * перестал бы выходить из функции.
   */
  private executeTry(stmt: Extract<Stmt, { kind: 'Try' }>): void {
    const depthBefore = this.stack.length;
    try {
      this.executeBlock(stmt.body, new Environment(this.env));
      return;
    } catch (e) {
      if (!(e instanceof DbgoError) || e.stage !== 'runtime') throw e;
      // Кадры вызовов, оборванных ошибкой, снимаем — обработчик выполняется на своём уровне.
      this.stack.length = depthBefore;
      const env = new Environment(this.env);
      if (stmt.param) env.define(stmt.param, describeError(e), false);
      this.executeBlock(stmt.handler, env);
    }
  }

  executeBlock(body: Stmt[], env: Environment): void {
    const prev = this.env;
    this.env = env;
    try {
      for (const stmt of body) this.execute(stmt);
    } finally {
      this.env = prev;
    }
  }

  private executeFor(stmt: Extract<Stmt, { kind: 'For' }>): void {
    const seq = this.evaluate(stmt.iterable);
    const items = this.iterate(seq, stmt.span);
    for (const item of items) {
      // Своя область на каждый виток: замыкания внутри цикла ловят разные значения.
      const env = new Environment(this.env);
      env.define(stmt.name, item, true);
      try {
        this.executeBlock((stmt.body as Extract<Stmt, { kind: 'Block' }>).body, env);
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
  }

  /** Что вообще можно перебрать в for. */
  iterate(seq: Value, span: Span): Iterable<Value> {
    if (Array.isArray(seq)) return [...seq];
    if (seq instanceof DbgoRange) return seq.toList();
    if (typeof seq === 'string') return [...seq];
    if (seq instanceof Map) return [...seq.keys()] as Value[];
    throw runtimeError(`по значению типа ${typeName(seq)} нельзя пройти циклом for`, span);
  }

  // ---- выражения ----------------------------------------------------------

  evaluate(expr: Expr): Value {
    switch (expr.kind) {
      case 'Number': return expr.value;
      case 'Str': return expr.value;
      case 'Bool': return expr.value;
      case 'Nil': return null;

      case 'Template': {
        let out = '';
        for (const part of expr.parts) {
          out += 'text' in part ? part.text : toStr(this.evaluate(part.expr));
        }
        return out;
      }

      case 'List':
        return expr.items.map((i) => this.evaluate(i));

      case 'Map': {
        const map = new Map<MapKey, Value>();
        for (const { key, value } of expr.entries) {
          map.set(asMapKey(this.evaluate(key), expr.span), this.evaluate(value));
        }
        return map;
      }

      case 'Ident':
        return this.env.get(expr.name, expr.span);

      case 'Fn':
        return new DbgoFunction(expr.name, expr.params, expr.body, this.env);

      case 'Range': {
        const start = this.numberOperand(this.evaluate(expr.start), 'начало диапазона', expr.span);
        const end = this.numberOperand(this.evaluate(expr.end), 'конец диапазона', expr.span);
        return new DbgoRange(start, end);
      }

      case 'Unary': {
        const right = this.evaluate(expr.right);
        if (expr.op === '!') return !truthy(right);
        return -this.numberOperand(right, 'операнд унарного минуса', expr.span);
      }

      case 'Logical': {
        const left = this.evaluate(expr.left);
        if (expr.op === '??') return left === null ? this.evaluate(expr.right) : left;
        if (expr.op === '&&' || expr.op === 'and') return truthy(left) ? this.evaluate(expr.right) : left;
        return truthy(left) ? left : this.evaluate(expr.right);
      }

      case 'Ternary':
        return truthy(this.evaluate(expr.cond)) ? this.evaluate(expr.then) : this.evaluate(expr.else);

      case 'Binary':
        return this.binary(expr.op, this.evaluate(expr.left), this.evaluate(expr.right), expr.span);

      case 'Get':
        return this.getMember(this.evaluate(expr.object), expr.name, expr.span);

      case 'Index':
        return this.getIndex(this.evaluate(expr.object), this.evaluate(expr.index), expr.span);

      case 'Call': {
        const callee = this.evaluate(expr.callee);
        const args = expr.args.map((a) => this.evaluate(a));
        return this.callValue(callee, args, expr.span, this.calleeName(expr.callee));
      }

      case 'Assign':
        return this.assign(expr);
    }
  }

  private calleeName(callee: Expr): string {
    if (callee.kind === 'Ident') return callee.name;
    if (callee.kind === 'Get') return callee.name;
    return 'анонимная функция';
  }

  private assign(expr: Extract<Expr, { kind: 'Assign' }>): Value {
    const value = this.evaluate(expr.value);
    const target = expr.target;

    if (target.kind === 'Ident') {
      this.env.assign(target.name, value, expr.span);
      return value;
    }

    if (target.kind === 'Get') {
      const obj = this.evaluate(target.object);
      if (obj instanceof DbgoModule) {
        throw runtimeError(`имена модуля «${obj.alias}» менять нельзя`, expr.span);
      }
      if (obj instanceof StructInstance) {
        if (!obj.fields.has(target.name)) {
          throw runtimeError(`у ${obj.def.name} нет поля «${target.name}»`, expr.span);
        }
        obj.fields.set(target.name, value);
        return value;
      }
      if (obj instanceof Map) {
        obj.set(target.name, value);
        return value;
      }
      throw runtimeError(`нельзя присвоить поле «${target.name}» значению типа ${typeName(obj)}`, expr.span);
    }

    if (target.kind !== 'Index') {
      throw runtimeError('присваивать можно только переменной, полю или элементу', expr.span);
    }
    const obj = this.evaluate(target.object);
    const key = this.evaluate(target.index);

    if (Array.isArray(obj)) {
      const i = this.listIndex(obj, key, expr.span);
      obj[i] = value;
      return value;
    }
    if (obj instanceof Map) {
      obj.set(asMapKey(key, expr.span), value);
      return value;
    }
    if (typeof obj === 'string') {
      throw runtimeError('строки неизменяемы — соберите новую строку вместо записи по индексу', expr.span);
    }
    throw runtimeError(`нельзя присвоить по индексу значению типа ${typeName(obj)}`, expr.span);
  }

  // ---- операции -----------------------------------------------------------

  private numberOperand(v: Value, what: string, span: Span): number {
    if (typeof v !== 'number') throw runtimeError(`${what} должен быть числом, а получен ${typeName(v)}`, span);
    return v;
  }

  private binary(op: string, l: Value, r: Value, span: Span): Value {
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
      case '-': return a - b;
      case '*': return a * b;
      case '/':
        if (b === 0) throw runtimeError('деление на ноль', span);
        return a / b;
      case '%':
        if (b === 0) throw runtimeError('остаток от деления на ноль', span);
        return a % b;
      case '^': return a ** b;
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
    return s.repeat(this.wholeCount(n, span));
  }

  // ---- доступ к членам ----------------------------------------------------

  getMember(obj: Value, name: string, span: Span): Value {
    if (obj === null) {
      throw runtimeError(`нельзя обратиться к «${name}» у nil — проверьте значение или используйте «??»`, span);
    }

    if (obj instanceof DbgoModule) {
      if (obj.exports.has(name)) return obj.exports.get(name)!;
      const near = nearest(name, [...obj.exports.keys()]);
      throw runtimeError(
        `в модуле «${obj.alias}» нет имени «${name}»${near ? ` — возможно, имелось в виду «${near}»` : ''}`,
        span,
      );
    }

    if (obj instanceof DbgoModule) {
      if (obj.exports.has(name)) return obj.exports.get(name)!;
      const near = nearest(name, [...obj.exports.keys()]);
      throw runtimeError(
        `в модуле «${obj.alias}» нет имени «${name}»${near ? ` — возможно, имелось в виду «${near}»` : ''}`,
        span,
      );
    }

    if (obj instanceof StructInstance) {
      if (obj.fields.has(name)) return obj.fields.get(name)!;
      const m = obj.def.methods.get(name);
      if (m) return m.bind(obj);
      throw runtimeError(`у ${obj.def.name} нет поля или метода «${name}»`, span);
    }

    // У словаря данные важнее методов: user.name должен работать всегда.
    if (obj instanceof Map && obj.has(name)) return obj.get(name)!;

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
      const chars = [...obj];
      if (typeof key !== 'number' || !Number.isInteger(key)) {
        throw runtimeError(`индекс строки должен быть целым числом, а получен ${typeName(key)}`, span);
      }
      const i = key < 0 ? chars.length + key : key;
      if (i < 0 || i >= chars.length) {
        throw runtimeError(`индекс ${key} вне строки длиной ${chars.length}`, span);
      }
      return chars[i]!;
    }

    if (obj instanceof Map) {
      const k = asMapKey(key, span);
      if (!obj.has(k)) throw runtimeError(`в словаре нет ключа ${repr(k as Value)}`, span);
      return obj.get(k)!;
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
    const required = fn.params.filter((p) => p.def === null).length;
    this.checkArity(fn.name ?? name, args.length, required, fn.params.length, span);

    if (this.stack.length >= MAX_DEPTH) {
      throw runtimeError(
        `слишком глубокая рекурсия: больше ${MAX_DEPTH} вложенных вызовов — ` +
        'проверьте условие выхода или перепишите цикл без рекурсии',
        span,
      );
    }

    const env = new Environment(fn.closure);
    if (fn.self) env.define('self', fn.self, false);
    this.bindParams(fn.params, args, env);

    this.stack.push({ name: fn.name ?? 'анонимная функция', span });
    try {
      this.executeBlock(fn.body, env);
      return null;
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      if (e instanceof DbgoError && e.stage === 'runtime' && e.trace.length < 12) {
        e.trace.push({ name: fn.name ?? 'анонимная функция', span });
      }
      throw e;
    } finally {
      this.stack.pop();
    }
  }

  private bindParams(params: Param[], args: Value[], env: Environment): void {
    params.forEach((p, i) => {
      const given = i < args.length ? args[i]! : null;
      // Значение по умолчанию вычисляется в области вызова — оно может ссылаться на другие параметры.
      const value = i < args.length ? given : p.def ? this.evaluateIn(p.def, env) : null;
      env.define(p.name, value, true);
    });
  }

  private evaluateIn(expr: Expr, env: Environment): Value {
    const prev = this.env;
    this.env = env;
    try {
      return this.evaluate(expr);
    } finally {
      this.env = prev;
    }
  }

  private construct(def: StructDef, args: Value[], span: Span): Value {
    const required = def.fields.filter((f) => f.def === null).length;
    this.checkArity(def.name, args.length, required, def.fields.length, span);
    const fields = new Map<string, Value>();
    const env = new Environment(this.globals);
    def.fields.forEach((f, i) => {
      const value = i < args.length ? args[i]! : f.def ? this.evaluateIn(f.def, env) : null;
      fields.set(f.name, value);
      env.define(f.name, value, true);
    });
    return new StructInstance(def, fields);
  }

  private checkArity(name: string, got: number, min: number, max: number, span: Span): void {
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
