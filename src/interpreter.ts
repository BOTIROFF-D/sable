import { join } from 'node:path';
import type { Expr, Param, Program, Stmt } from './ast.ts';
import { DbgoError, runtimeError, type Span } from './errors.ts';
import { Environment } from './environment.ts';
import { ModuleLoader } from './modules.ts';
import { findMethodEntry, getMethod, installGlobals, repeatText, type MethodEntry } from './stdlib.ts';
import {
  DbgoModule, NativeFn, DbgoFunction, DbgoRange, StructDef, StructInstance,
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
  private env: Environment;
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
    let sig: Signal;
    try {
      sig = this.executeBlock(program, moduleEnv);
    } finally {
      this.currentFile = prevFile;
    }
    if (sig !== NORMAL) throw escaped(sig);
    return moduleEnv.ownEntries();
  }

  run(program: Program): void {
    try {
      for (const stmt of program) {
        const sig = this.execute(stmt);
        if (sig !== NORMAL) throw escaped(sig);
      }
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
        else {
          const sig = this.execute(stmt);
          if (sig !== NORMAL) throw escaped(sig);
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

  // ---- инструкции ---------------------------------------------------------

  private execute(stmt: Stmt): Signal {
    switch (stmt.kind) {
      case 'ExprStmt':
        this.evaluate(stmt.expr);
        return NORMAL;

      case 'VarDecl':
        this.env.define(stmt.name, this.evaluate(stmt.init), stmt.mutable, stmt.span);
        return NORMAL;

      case 'If':
        if (truthy(this.evaluate(stmt.cond))) return this.execute(stmt.then);
        if (stmt.else) return this.execute(stmt.else);
        return NORMAL;

      case 'Block':
        return this.executeBlock(stmt.body, new Environment(this.env));

      case 'Return':
        this.returnValue = stmt.value ? this.evaluate(stmt.value) : null;
        return RETURN;

      case 'While':
        while (truthy(this.evaluate(stmt.cond))) {
          const sig = this.execute(stmt.body);
          if (sig === BREAK) break;
          if (sig === RETURN) return RETURN;
        }
        return NORMAL;

      case 'For':
        return this.executeFor(stmt);

      case 'Try':
        return this.executeTry(stmt);

      case 'Break':
        this.signalSpan = stmt.span;
        return BREAK;

      case 'Continue':
        this.signalSpan = stmt.span;
        return CONTINUE;

      case 'FnDecl': {
        const fn = new DbgoFunction(stmt.name, stmt.params, stmt.body, this.env);
        this.env.define(stmt.name, fn, false, stmt.span);
        return NORMAL;
      }

      case 'StructDecl': {
        const methods = new Map<string, DbgoFunction>();
        const def = new StructDef(stmt.name, stmt.fields, methods);
        for (const m of stmt.methods) {
          methods.set(m.name, new DbgoFunction(`${stmt.name}.${m.name}`, m.params, m.body, this.env));
        }
        this.env.define(stmt.name, def, false, stmt.span);
        return NORMAL;
      }

      case 'Import': {
        const mod = this.modules.load(this, stmt.path, this.currentFile, stmt.alias, stmt.span);
        this.env.define(stmt.alias, mod, false, stmt.span);
        return NORMAL;
      }
    }
  }

  /**
   * try/catch перехватывает только ошибки выполнения самой программы.
   * Сигналы return/break/continue проходят насквозь: иначе `return` изнутри try
   * перестал бы выходить из функции.
   */
  private executeTry(stmt: Extract<Stmt, { kind: 'Try' }>): Signal {
    const depthBefore = this.depth;
    try {
      return this.executeBlock(stmt.body, new Environment(this.env));
    } catch (e) {
      if (!(e instanceof DbgoError) || e.stage !== 'runtime') throw e;
      // Кадры вызовов, оборванных ошибкой, снимаем — обработчик выполняется на своём уровне.
      this.depth = depthBefore;
      const env = new Environment(this.env);
      if (stmt.param) env.define(stmt.param, describeError(e), false);
      return this.executeBlock(stmt.handler, env);
    }
  }

  executeBlock(body: Stmt[], env: Environment): Signal {
    const prev = this.env;
    this.env = env;
    try {
      for (let i = 0; i < body.length; i++) {
        const sig = this.execute(body[i]!);
        if (sig !== NORMAL) return sig;
      }
      return NORMAL;
    } finally {
      this.env = prev;
    }
  }

  private executeFor(stmt: Extract<Stmt, { kind: 'For' }>): Signal {
    const seq = this.evaluate(stmt.iterable);
    const body = (stmt.body as Extract<Stmt, { kind: 'Block' }>).body;
    const name = stmt.name;

    // Диапазон перебирается счётчиком: ради `for i in 0..1000000` незачем
    // сначала строить миллион элементов в памяти.
    if (seq instanceof DbgoRange) {
      for (let i = seq.start; i < seq.end; i++) {
        const sig = this.forStep(name, body, i);
        if (sig === BREAK) break;
        if (sig === RETURN) return RETURN;
      }
      return NORMAL;
    }

    const items = this.iterate(seq, stmt.span);
    for (let k = 0; k < items.length; k++) {
      const sig = this.forStep(name, body, items[k]!);
      if (sig === BREAK) break;
      if (sig === RETURN) return RETURN;
    }
    return NORMAL;
  }

  /** Один виток for: своя область, тело, разбор сигнала. */
  private forStep(name: string, body: Stmt[], item: Value): Signal {
    // Своя область на каждый виток: замыкания внутри цикла ловят разные значения.
    const env = new Environment(this.env);
    env.define(name, item, true);
    return this.executeBlock(body, env);
  }

  /**
   * Что вообще можно перебрать в for. Список копируется: изменение исходного
   * списка внутри цикла не должно менять то, что цикл ещё пройдёт.
   * Диапазон здесь тоже разворачивается, но `executeFor` до этого не доходит —
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

  // Порядок case здесь — по частоте, а не по алфавиту: switch по строке V8
  // разворачивает в цепочку сравнений, поэтому самые ходовые узлы стоят первыми.
  evaluate(expr: Expr): Value {
    switch (expr.kind) {
      case 'Ident':
        return this.env.get(expr.name, expr.span);

      case 'Number': return expr.value;

      case 'Binary':
        return this.binary(expr.op, this.evaluate(expr.left), this.evaluate(expr.right), expr.span);

      case 'Call': {
        const target = expr.callee;
        // `значение.метод(...)` — самый частый вызов в коде. Идём напрямую к реализации,
        // не создавая на каждое обращение объект-функцию, который живёт до конца вызова.
        if (target.kind === 'Get') {
          const obj = this.evaluate(target.object);
          const entry = fastMethodOf(obj, target.name);
          if (entry) {
            const list = expr.args;
            const args: Value[] = new Array(list.length);
            for (let i = 0; i < list.length; i++) args[i] = this.evaluate(list[i]!);
            this.checkArity(`${typeName(obj)}.${target.name}`, args.length, entry.min, entry.max, expr.span);
            return entry.impl(obj as never, args, expr.span, this);
          }
          const bound = this.getMember(obj, target.name, target.span);
          const list = expr.args;
          const args: Value[] = new Array(list.length);
          for (let i = 0; i < list.length; i++) args[i] = this.evaluate(list[i]!);
          return this.callValue(bound, args, expr.span, target.name);
        }

        const callee = this.evaluate(target);
        const list = expr.args;
        const args: Value[] = new Array(list.length);
        for (let i = 0; i < list.length; i++) args[i] = this.evaluate(list[i]!);
        return this.callValue(callee, args, expr.span, this.calleeName(target));
      }

      case 'Get':
        return this.getMember(this.evaluate(expr.object), expr.name, expr.span);

      case 'Index':
        return this.getIndex(this.evaluate(expr.object), this.evaluate(expr.index), expr.span);

      case 'Assign':
        return this.assign(expr);

      case 'Str': return expr.value;
      case 'Bool': return expr.value;
      case 'Nil': return null;

      case 'Template': return this.template(expr);
      case 'List': return this.listLiteral(expr);
      case 'Map': return this.mapLiteral(expr);

      case 'Fn':
        return new DbgoFunction(expr.name, expr.params, expr.body, this.env);

      case 'Range': return this.range(expr);

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

    }
  }

  private template(expr: Extract<Expr, { kind: 'Template' }>): string {
    const parts = expr.parts;
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      // Кусок текста или вставка — различаются наличием поля. Проверка поля,
      // а не оператор «in»: тот на разнотипных объектах заметно дороже.
      const text = (part as { text?: string }).text;
      out += text !== undefined ? text : toStr(this.evaluate((part as { expr: Expr }).expr));
    }
    return out;
  }

  private listLiteral(expr: Extract<Expr, { kind: 'List' }>): Value[] {
    const items = expr.items;
    const out: Value[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) out[i] = this.evaluate(items[i]!);
    return out;
  }

  private mapLiteral(expr: Extract<Expr, { kind: 'Map' }>): Map<MapKey, Value> {
    const map = new Map<MapKey, Value>();
    for (const { key, value } of expr.entries) {
      map.set(asMapKey(this.evaluate(key), expr.span), this.evaluate(value));
    }
    return map;
  }

  private range(expr: Extract<Expr, { kind: 'Range' }>): DbgoRange {
    const start = this.numberOperand(this.evaluate(expr.start), 'начало диапазона', expr.span);
    const end = this.numberOperand(this.evaluate(expr.end), 'конец диапазона', expr.span);
    // За пределом точных целых прибавление единицы перестаёт двигать счётчик:
    // такой цикл не закончится не «когда-нибудь», а никогда. Бесконечность — тот же случай.
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw runtimeError('границы диапазона должны быть обычными числами', expr.span);
    }
    if (Math.abs(start) > Number.MAX_SAFE_INTEGER || Math.abs(end) > Number.MAX_SAFE_INTEGER) {
      throw runtimeError(
        `границы диапазона больше ${Number.MAX_SAFE_INTEGER} — за этим пределом ` +
        'счётчик перестаёт расти, и цикл не закончится никогда',
        expr.span,
      );
    }
    return new DbgoRange(start, end);
  }

  private calleeName(callee: Expr): string {
    if (callee.kind === 'Ident') return callee.name;
    if (callee.kind === 'Get') return callee.name;
    return 'анонимная функция';
  }

  private assign(expr: Extract<Expr, { kind: 'Assign' }>): Value {
    const target = expr.target;
    const op = expr.op;

    // Части цели вычисляются ровно один раз. Раньше «a[i] += v» разворачивалось
    // парсером в «a[i] = a[i] + v», и i считался дважды: при побочном эффекте
    // в индексе читали одну ячейку, а писали в другую.
    if (target.kind === 'Ident') {
      const value = op === null
        ? this.evaluate(expr.value)
        : this.binary(op, this.env.get(target.name, target.span), this.evaluate(expr.value), expr.span);
      this.env.assign(target.name, value, expr.span);
      return value;
    }

    if (target.kind === 'Get') {
      const obj = this.evaluate(target.object);
      const value = op === null
        ? this.evaluate(expr.value)
        : this.binary(op, this.getMember(obj, target.name, target.span), this.evaluate(expr.value), expr.span);

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
    const value = op === null
      ? this.evaluate(expr.value)
      : this.binary(op, this.getIndex(obj, key, target.span), this.evaluate(expr.value), expr.span);

    if (Array.isArray(obj)) {
      obj[this.listIndex(obj, key, expr.span)] = value;
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
    this.bindParams(fn.params, args, env);

    this.depth++;
    try {
      const sig = this.executeBlock(fn.body, env);
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

  private bindParams(params: Param[], args: Value[], env: Environment): void {
    const n = args.length;
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      // Значение по умолчанию вычисляется в области вызова — оно может ссылаться на другие параметры.
      const value = i < n ? args[i]! : p.def ? this.evaluateIn(p.def, env) : null;
      env.define(p.name, value, true);
    }
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
    const list = def.fields;
    const n = args.length;
    this.checkArity(def.name, n, def.required, list.length, span);
    const fields = new Map<string, Value>();
    // Область нужна только значениям по умолчанию: они видят уже посчитанные поля.
    // Если аргументов хватило на все поля, ни одно из них не вычисляется.
    const env = n < list.length ? new Environment(this.globals) : null;
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!;
      const value = i < n ? args[i]! : f.def ? this.evaluateIn(f.def, env!) : null;
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
