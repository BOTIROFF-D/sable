import { readFileSync, readSync, writeFileSync } from 'node:fs';
import { SableError, runtimeError, type Span } from './errors.ts';
import type { Interpreter } from './interpreter.ts';
import {
  NativeFn, SableFunction, SableRange, StructDef, StructInstance,
  asMapKey, equals, repr, toStr, truthy, typeName,
  type MapKey, type Value,
} from './values.ts';

// ---- проверки аргументов --------------------------------------------------

const ORDINAL = ['первый', 'второй', 'третий', 'четвёртый', 'пятый'];
const ordinal = (i: number) => ORDINAL[i] ?? `${i + 1}-й`;

function wantNumber(fn: string, args: Value[], i: number, span: Span): number {
  const v = args[i];
  if (typeof v !== 'number') {
    throw runtimeError(`${ordinal(i)} аргумент «${fn}» должен быть числом, а получен ${typeName(v ?? null)}`, span);
  }
  return v;
}

function wantString(fn: string, args: Value[], i: number, span: Span): string {
  const v = args[i];
  if (typeof v !== 'string') {
    throw runtimeError(`${ordinal(i)} аргумент «${fn}» должен быть строкой, а получен ${typeName(v ?? null)}`, span);
  }
  return v;
}

function wantInt(fn: string, args: Value[], i: number, span: Span): number {
  const n = wantNumber(fn, args, i, span);
  if (!Number.isInteger(n)) {
    throw runtimeError(`${ordinal(i)} аргумент «${fn}» должен быть целым числом, а получен ${repr(n)}`, span);
  }
  return n;
}

function wantList(fn: string, args: Value[], i: number, span: Span): Value[] {
  const v = args[i];
  if (!Array.isArray(v)) {
    throw runtimeError(`${ordinal(i)} аргумент «${fn}» должен быть списком, а получен ${typeName(v ?? null)}`, span);
  }
  return v;
}

/** Целое «сколько штук»: отрицательное количество почти всегда опечатка, а не намерение. */
function wantCount(fn: string, args: Value[], i: number, span: Span): number {
  const n = wantInt(fn, args, i, span);
  if (n < 0) throw runtimeError(`${ordinal(i)} аргумент «${fn}» — количество, оно не может быть отрицательным (получено ${n})`, span);
  return n;
}

const arg = (args: Value[], i: number): Value => (i < args.length ? args[i]! : null);

/**
 * Копия списка для обхода. Колбэк вправе менять исходный список прямо во время
 * обхода (`xs.map(x -> xs.pop())`), и тогда методы JS оставляют в результате
 * пустые ячейки — наружу вылезало бы `undefined`, значения без типа в языке.
 * Обход по копии повторяет правило цикла `for`, где список тоже копируется.
 */
const snap = (l: Value[]): Value[] => l.slice();

/**
 * В языке нет бесконечности и «не числа» — то же правило, что для операторов.
 * Иначе pow(0, -1) даёт inf там, где 1 / 0 честно ошибка.
 */
function finiteResult(fn: string, n: number, span: Span): number {
  if (Number.isFinite(n)) return n;
  throw runtimeError(
    Number.isNaN(n)
      ? `результат «${fn}» не является числом`
      : `результат «${fn}» вышел за пределы представимых чисел`,
    span,
  );
}

// ---- глобальные функции ---------------------------------------------------

export function installGlobals(interp: Interpreter): void {
  const def = (name: string, min: number, max: number, impl: (a: Value[], s: Span) => Value) => {
    interp.builtins.define(name, new NativeFn(name, min, max, impl), false);
  };
  const call = (f: Value, args: Value[], span: Span, who: string): Value => {
    if (!(f instanceof SableFunction || f instanceof NativeFn)) {
      throw runtimeError(`«${who}» ожидает функцию, а получила ${typeName(f)}`, span);
    }
    return interp.callCallback(f, args, span, who);
  };

  def('print', 0, Infinity, (args) => {
    interp.host.write(args.map((a) => toStr(a)).join(' ') + '\n');
    return null;
  });

  def('write', 0, Infinity, (args) => {
    interp.host.write(args.map((a) => toStr(a)).join(' '));
    return null;
  });

  def('len', 1, 1, (args, span) => lengthOf(arg(args, 0), span));
  def('type', 1, 1, (args) => typeName(arg(args, 0)));
  def('str', 1, 1, (args) => toStr(arg(args, 0)));
  def('repr', 1, 1, (args) => repr(arg(args, 0)));
  def('bool', 1, 1, (args) => truthy(arg(args, 0)));

  def('num', 1, 2, (args, span) => {
    const v = arg(args, 0);
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      const t = v.trim().replace(/_/g, '');
      const n = t === '' ? NaN : Number(t);
      // Бесконечность отсекается наравне с мусором: «Infinity» и «1e999» —
      // такие же непредставимые в языке значения, как «привет».
      if (!Number.isFinite(n)) {
        if (args.length > 1) return arg(args, 1);
        throw runtimeError(`строку ${repr(v)} нельзя разобрать как число — передайте вторым аргументом запасное значение`, span);
      }
      return n;
    }
    if (args.length > 1) return arg(args, 1);
    throw runtimeError(`значение типа ${typeName(v)} нельзя превратить в число`, span);
  });

  def('int', 1, 1, (args, span) => Math.trunc(wantNumber('int', args, 0, span)));
  def('abs', 1, 1, (args, span) => Math.abs(wantNumber('abs', args, 0, span)));
  def('floor', 1, 1, (args, span) => Math.floor(wantNumber('floor', args, 0, span)));
  def('ceil', 1, 1, (args, span) => Math.ceil(wantNumber('ceil', args, 0, span)));
  def('sqrt', 1, 1, (args, span) => {
    const n = wantNumber('sqrt', args, 0, span);
    if (n < 0) throw runtimeError('корень из отрицательного числа не определён', span);
    return Math.sqrt(n);
  });
  def('pow', 2, 2, (args, span) =>
    finiteResult('pow', wantNumber('pow', args, 0, span) ** wantNumber('pow', args, 1, span), span));

  def('round', 1, 2, (args, span) => {
    const n = wantNumber('round', args, 0, span);
    const digits = args.length > 1 ? wantInt('round', args, 1, span) : 0;
    const k = 10 ** digits;
    // Половина округляется от нуля в обе стороны: round(2.5)=3, round(-2.5)=-3.
    return finiteResult('round', (Math.sign(n) * Math.round(Math.abs(n) * k + Number.EPSILON)) / k, span);
  });

  def('min', 1, Infinity, (args, span) => extremum('min', args, span, (a, b) => a < b));
  def('max', 1, Infinity, (args, span) => extremum('max', args, span, (a, b) => a > b));

  def('sign', 1, 1, (args, span) => Math.sign(wantNumber('sign', args, 0, span)));
  def('clamp', 3, 3, (args, span) => {
    const n = wantNumber('clamp', args, 0, span);
    const lo = wantNumber('clamp', args, 1, span);
    const hi = wantNumber('clamp', args, 2, span);
    if (lo > hi) throw runtimeError(`в clamp нижняя граница ${repr(lo)} больше верхней ${repr(hi)}`, span);
    return Math.min(hi, Math.max(lo, n));
  });

  def('exp', 1, 1, (args, span) => finiteResult('exp', Math.exp(wantNumber('exp', args, 0, span)), span));
  def('log', 1, 2, (args, span) => {
    const n = wantNumber('log', args, 0, span);
    if (n <= 0) throw runtimeError(`логарифм определён только для положительных чисел, а получено ${repr(n)}`, span);
    if (args.length < 2) return Math.log(n);
    const base = wantNumber('log', args, 1, span);
    if (base <= 0 || base === 1) {
      throw runtimeError(`основание логарифма должно быть положительным и не равным 1, а получено ${repr(base)}`, span);
    }
    // Двойка и десятка считаются отдельно: через деление логарифмов log(1000, 10) дало бы 2.9999999999999996.
    if (base === 2) return Math.log2(n);
    if (base === 10) return Math.log10(n);
    return Math.log(n) / Math.log(base);
  });

  def('hypot', 2, Infinity, (args, span) =>
    finiteResult('hypot', Math.hypot(...args.map((_, i) => wantNumber('hypot', args, i, span))), span));
  def('sin', 1, 1, (args, span) => Math.sin(wantNumber('sin', args, 0, span)));
  def('cos', 1, 1, (args, span) => Math.cos(wantNumber('cos', args, 0, span)));
  def('tan', 1, 1, (args, span) => Math.tan(wantNumber('tan', args, 0, span)));
  def('atan', 1, 1, (args, span) => Math.atan(wantNumber('atan', args, 0, span)));
  def('atan2', 2, 2, (args, span) => Math.atan2(wantNumber('atan2', args, 0, span), wantNumber('atan2', args, 1, span)));
  def('asin', 1, 1, (args, span) => unitInterval('asin', args, span, Math.asin));
  def('acos', 1, 1, (args, span) => unitInterval('acos', args, span, Math.acos));

  // Число π — функцией, а не именем PI: имена в глобальной области нельзя перекрыть
  // своим let/const, и встроенное PI отняло бы у программы ходовое имя.
  def('pi', 0, 0, () => Math.PI);

  def('random', 0, 0, () => Math.random());
  def('random_int', 2, 2, (args, span) => {
    const lo = wantInt('random_int', args, 0, span);
    const hi = wantInt('random_int', args, 1, span);
    if (hi < lo) throw runtimeError(`в random_int верхняя граница ${hi} меньше нижней ${lo}`, span);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  });

  def('now', 0, 0, () => Date.now());
  def('clock', 0, 0, () => performance.now() / 1000);

  def('range', 1, 3, (args, span) => {
    const a = wantNumber('range', args, 0, span);
    const b = args.length > 1 ? wantNumber('range', args, 1, span) : null;
    const step = args.length > 2 ? wantNumber('range', args, 2, span) : 1;
    if (step === 0) throw runtimeError('шаг range не может быть нулём', span);
    const [start, end] = b === null ? [0, a] : [a, b];
    const count = Math.max(0, Math.ceil((end - start) / step));
    if (!Number.isFinite(count) || count > MAX_ITEMS) {
      throw runtimeError(
        `range попросили построить ${Number.isFinite(count) ? count : 'бесконечно много'} элементов — предел ${MAX_ITEMS}`,
        span,
      );
    }
    const out: Value[] = [];
    if (step > 0) for (let i = start; i < end; i += step) out.push(i);
    else for (let i = start; i > end; i += step) out.push(i);
    return out;
  });

  def('keys', 1, 1, (args, span) => [...asMap('keys', arg(args, 0), span).keys()] as Value[]);
  def('values', 1, 1, (args, span) => [...asMap('values', arg(args, 0), span).values()]);
  def('entries', 1, 1, (args, span) =>
    [...asMap('entries', arg(args, 0), span).entries()].map(([k, v]) => [k as Value, v]));

  def('assert', 1, 2, (args, span) => {
    if (truthy(arg(args, 0))) return null;
    const msg = args.length > 1 ? toStr(arg(args, 1)) : 'проверка не прошла';
    throw new SableError('runtime', `assert: ${msg}`, span);
  });

  def('error', 1, 1, (args, span) => {
    const v = arg(args, 0);
    throw new SableError('runtime', toStr(v), span, [], v);
  });

  def('read_file', 1, 1, (args, span) => {
    const path = wantString('read_file', args, 0, span);
    try {
      return readFileSync(path, 'utf8');
    } catch {
      throw runtimeError(`не удалось прочитать файл «${path}»`, span);
    }
  });

  def('write_file', 2, 2, (args, span) => {
    const path = wantString('write_file', args, 0, span);
    try {
      writeFileSync(path, toStr(arg(args, 1)), 'utf8');
      return null;
    } catch {
      throw runtimeError(`не удалось записать файл «${path}»`, span);
    }
  });

  def('to_json', 1, 2, (args, span) => {
    const indent = args.length > 1 ? wantInt('to_json', args, 1, span) : 0;
    return JSON.stringify(toPlain(arg(args, 0), span), null, indent);
  });

  def('from_json', 1, 1, (args, span) => {
    const text = wantString('from_json', args, 0, span);
    try {
      return fromPlain(JSON.parse(text), span);
    } catch (e) {
      if (e instanceof SableError) throw e;
      throw runtimeError('строка не является корректным JSON', span);
    }
  });

  def('input', 0, 1, (args, span) => {
    if (args.length > 0) interp.host.write(toStr(arg(args, 0)));
    return readLineSync(span);
  });

  def('map', 2, 2, (args, span) => {
    const items = asSeq('map', arg(args, 0), span);
    return items.map((x, i) => call(arg(args, 1), [x, i], span, 'map'));
  });
  def('filter', 2, 2, (args, span) => {
    const items = asSeq('filter', arg(args, 0), span);
    return items.filter((x, i) => truthy(call(arg(args, 1), [x, i], span, 'filter')));
  });
  def('reduce', 3, 3, (args, span) => {
    const items = asSeq('reduce', arg(args, 0), span);
    let acc = arg(args, 2);
    items.forEach((x, i) => { acc = call(arg(args, 1), [acc, x, i], span, 'reduce'); });
    return acc;
  });
  def('sum', 1, 1, (args, span) => {
    const items = asSeq('sum', arg(args, 0), span);
    let total = 0;
    for (const x of items) {
      if (typeof x !== 'number') throw runtimeError(`«sum» работает только с числами, встретился ${typeName(x)}`, span);
      total += x;
    }
    return total;
  });

  def('zip', 2, 2, (args, span) =>
    zipSeq(asSeq('zip', arg(args, 0), span), asSeq('zip', arg(args, 1), span)));

  def('enumerate', 1, 1, (args, span) => enumerateSeq(asSeq('enumerate', arg(args, 0), span)));

  def('sorted', 1, 2, (args, span) => {
    const items = [...asSeq('sorted', arg(args, 0), span)];
    if (args.length < 2) return items.sort((x, y) => defaultCompare(x, y, span, 'sorted'));
    return items.sort((x, y) => {
      const r = call(arg(args, 1), [x, y], span, 'sorted');
      if (typeof r !== 'number') {
        throw runtimeError(`функция сравнения в sorted должна вернуть число, а вернула ${typeName(r)}`, span);
      }
      return r;
    });
  });

  def('reversed', 1, 1, (args, span) => [...asSeq('reversed', arg(args, 0), span)].reverse());

  def('from_entries', 1, 1, (args, span) => {
    const pairs = wantList('from_entries', args, 0, span);
    const out = new Map<MapKey, Value>();
    pairs.forEach((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw runtimeError(
          `элемент ${i} в «from_entries» должен быть парой [ключ, значение], а получен ${repr(pair)}`,
          span,
        );
      }
      out.set(asMapKey(pair[0]!, span), pair[1]!);
    });
    return out;
  });
}

// ---- вспомогательное ------------------------------------------------------

function extremum(name: string, args: Value[], span: Span, better: (a: number, b: number) => boolean): Value {
  const items = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (items.length === 0) throw runtimeError(`«${name}» нужен хотя бы один элемент`, span);
  let best: number | null = null;
  for (const x of items) {
    if (typeof x !== 'number') throw runtimeError(`«${name}» работает только с числами, встретился ${typeName(x)}`, span);
    if (best === null || better(x, best)) best = x;
  }
  return best!;
}

function unitInterval(name: string, args: Value[], span: Span, f: (n: number) => number): number {
  const n = wantNumber(name, args, 0, span);
  if (n < -1 || n > 1) throw runtimeError(`«${name}» определён только на отрезке от -1 до 1, а получено ${repr(n)}`, span);
  return f(n);
}

/** Пары «бок о бок»; лишний хвост длинной последовательности отбрасывается. */
function zipSeq(a: Value[], b: Value[]): Value[] {
  const out: Value[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) out.push([a[i]!, b[i]!]);
  return out;
}

function enumerateSeq(items: Value[]): Value[] {
  return items.map((x, i) => [i as Value, x]);
}

function asMap(fn: string, v: Value, span: Span): Map<MapKey, Value> {
  if (v instanceof Map) return v;
  throw runtimeError(`«${fn}» ожидает словарь, а получила ${typeName(v)}`, span);
}

function asSeq(fn: string, v: Value, span: Span): Value[] {
  // Копия, а не сам список: колбэк вправе менять исходный прямо во время обхода.
  if (Array.isArray(v)) return v.slice();
  if (v instanceof SableRange) return v.toList();
  if (typeof v === 'string') return [...v];
  throw runtimeError(`«${fn}» ожидает список, строку или диапазон, а получила ${typeName(v)}`, span);
}

function lengthOf(v: Value, span: Span): number {
  if (typeof v === 'string') return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map) return v.size;
  if (v instanceof SableRange) return v.length;
  throw runtimeError(`у значения типа ${typeName(v)} нет длины`, span);
}

function toPlain(v: Value, span: Span, seen: Set<object> = new Set()): unknown {
  // Список или структура вправе ссылаться на себя. Без этой памяти обход уходил
  // в бесконечную рекурсию и роняло стек JS — то есть вместо ошибки языка
  // пользователь видел чужое сообщение про вложенность вычислений.
  if (typeof v === 'object' && v !== null) {
    if (seen.has(v)) throw runtimeError('значение ссылается само на себя — в JSON его не записать', span);
    seen.add(v);
  }
  const out = toPlainInner(v, span, seen);
  if (typeof v === 'object' && v !== null) seen.delete(v);
  return out;
}

function toPlainInner(v: Value, span: Span, seen: Set<object>): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => toPlain(x, span, seen));
  if (v instanceof SableRange) return v.toList().map((x) => toPlain(x, span, seen));
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v) {
      // Ключи 1 и "1" в JSON неразличимы. Молча терять одну из записей нельзя.
      const name = String(k);
      if (Object.hasOwn(o, name)) {
        throw runtimeError(`ключи ${repr(k as Value)} и «${name}» в JSON неразличимы — запись потерялась бы`, span);
      }
      o[name] = toPlain(val, span, seen);
    }
    return o;
  }
  if (v instanceof StructInstance) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v.fields) o[k] = toPlain(val, span, seen);
    return o;
  }
  throw runtimeError(`значение типа ${typeName(v)} нельзя превратить в JSON`, span);
}

function fromPlain(v: unknown, span: Span): Value {
  if (v === null) return null;
  if (typeof v === 'number') {
    // JSON умеет записать 1e999; в языке такого числа нет.
    if (!Number.isFinite(v)) throw runtimeError(`в JSON встретилось слишком большое число: ${v}`, span);
    return v;
  }
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => fromPlain(x, span));
  if (typeof v === 'object') {
    const m = new Map<MapKey, Value>();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) m.set(k, fromPlain(val, span));
    return m;
  }
  return null;
}

/**
 * Синхронное чтение строки со stdin — иначе input() не вписался бы в дерево вычислений.
 * Байты копятся сырыми и декодируются целиком: иначе кириллица порвалась бы посередине.
 */
function readLineSync(span: Span): Value {
  const buf = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EOF') break;
      throw runtimeError('не удалось прочитать ввод', span);
    }
    if (n === 0) break;
    if (buf[0] === 0x0a) return Buffer.from(bytes).toString('utf8');
    if (buf[0] !== 0x0d) bytes.push(buf[0]!);
  }
  return bytes.length === 0 ? null : Buffer.from(bytes).toString('utf8');
}

// ---- методы на встроенных типах -------------------------------------------

type MethodTable = Record<string, { min: number; max: number; impl: (self: never, args: Value[], span: Span, interp: Interpreter) => Value }>;

const m = (min: number, max: number, impl: (self: never, args: Value[], span: Span, interp: Interpreter) => Value) =>
  ({ min, max, impl });

const STRING_METHODS: MethodTable = {
  len: m(0, 0, (s: string) => [...s].length),
  upper: m(0, 0, (s: string) => s.toUpperCase()),
  lower: m(0, 0, (s: string) => s.toLowerCase()),
  trim: m(0, 0, (s: string) => s.trim()),
  chars: m(0, 0, (s: string) => [...s] as Value[]),
  reverse: m(0, 0, (s: string) => [...s].reverse().join('')),
  contains: m(1, 1, (s: string, a, sp) => s.includes(wantString('contains', a, 0, sp))),
  starts_with: m(1, 1, (s: string, a, sp) => s.startsWith(wantString('starts_with', a, 0, sp))),
  ends_with: m(1, 1, (s: string, a, sp) => s.endsWith(wantString('ends_with', a, 0, sp))),
  // Позиция считается в символах, а не в кодовых единицах UTF-16 — чтобы совпадать с len() и slice().
  index_of: m(1, 1, (s: string, a, sp) => {
    const at = s.indexOf(wantString('index_of', a, 0, sp));
    return at < 0 ? -1 : [...s.slice(0, at)].length;
  }),
  replace: m(2, 2, (s: string, a, sp) =>
    s.split(wantString('replace', a, 0, sp)).join(wantString('replace', a, 1, sp))),
  split: m(0, 1, (s: string, a, sp) =>
    (a.length === 0 ? [...s] : wantString('split', a, 0, sp) === '' ? [...s] : s.split(wantString('split', a, 0, sp))) as Value[]),
  slice: m(1, 2, (s: string, a, sp) => {
    const chars = [...s];
    const [from, to] = sliceBounds('slice', chars.length, a, sp);
    return chars.slice(from, to).join('');
  }),
  repeat: m(1, 1, (s: string, a, sp) => {
    const n = wantInt('repeat', a, 0, sp);
    if (n < 0) throw runtimeError('число повторов не может быть отрицательным', sp);
    return repeatText(s, n, sp);
  }),
  // Дополнение считается в символах, как len и slice. По кодовым единицам
  // UTF-16 колонки разъезжались ровно там, ради чего эти методы и нужны:
  // «😀бот» занимал на клетку меньше, чем «Гулноз».
  pad_start: m(1, 2, (s: string, a, sp) => padText(s, a, sp, 'pad_start', true)),
  pad_end: m(1, 2, (s: string, a, sp) => padText(s, a, sp, 'pad_end', false)),
  is_empty: m(0, 0, (s: string) => s.length === 0),
  trim_start: m(0, 0, (s: string) => s.trimStart()),
  trim_end: m(0, 0, (s: string) => s.trimEnd()),
  // Последний перевод строки не порождает пустую строку в конце: "a\nb\n" — это две строки, а не три.
  lines: m(0, 0, (s: string) => {
    if (s === '') return [] as Value[];
    const body = s.endsWith('\n') ? s.slice(0, -1) : s;
    return body.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)) as Value[];
  }),
  words: m(0, 0, (s: string) => {
    const t = s.trim();
    return (t === '' ? [] : t.split(/\s+/u)) as Value[];
  }),
  capitalize: m(0, 0, (s: string) => capFirst(s)),
  title: m(0, 0, (s: string) => s.replace(/\S+/gu, (w) => capFirst(w))),
  count: m(1, 1, (s: string, a, sp) => {
    const sub = wantString('count', a, 0, sp);
    if (sub === '') throw runtimeError('«count» не считает пустую подстроку — передайте непустую', sp);
    return s.split(sub).length - 1;
  }),
  split_once: m(1, 1, (s: string, a, sp) => {
    const sep = wantString('split_once', a, 0, sp);
    if (sep === '') throw runtimeError('разделитель в «split_once» не может быть пустым', sp);
    const at = s.indexOf(sep);
    return at < 0 ? null : ([s.slice(0, at), s.slice(at + sep.length)] as Value);
  }),
  format: m(0, Infinity, (s: string, a, sp) => {
    const holes = s.match(/\{\}/g)?.length ?? 0;
    if (holes !== a.length) {
      throw runtimeError(`в «format» подстановок {} — ${holes}, а аргументов — ${a.length}: их должно быть поровну`, sp);
    }
    let i = 0;
    return s.replace(/\{\}/g, () => toStr(a[i++]!));
  }),
};

const LIST_METHODS: MethodTable = {
  len: m(0, 0, (l: Value[]) => l.length),
  push: m(1, Infinity, (l: Value[], a) => { l.push(...a); return l as Value; }),
  pop: m(0, 0, (l: Value[], _a, sp) => {
    if (l.length === 0) throw runtimeError('нельзя снять элемент с пустого списка', sp);
    return l.pop()!;
  }),
  insert: m(2, 2, (l: Value[], a, sp) => {
    const i = wantInt('insert', a, 0, sp);
    // Отрицательная позиция считается с конца — как у remove_at и у xs[-1].
    // Раньше insert был единственным исключением из общего правила.
    const at = i < 0 ? l.length + i : i;
    if (at < 0 || at > l.length) throw runtimeError(`позиция ${i} вне списка длиной ${l.length}`, sp);
    l.splice(at, 0, a[1]!);
    return l as Value;
  }),
  remove_at: m(1, 1, (l: Value[], a, sp) => {
    const i = wantInt('remove_at', a, 0, sp);
    const idx = i < 0 ? l.length + i : i;
    if (idx < 0 || idx >= l.length) throw runtimeError(`индекс ${i} вне списка длиной ${l.length}`, sp);
    return l.splice(idx, 1)[0]!;
  }),
  contains: m(1, 1, (l: Value[], a) => l.some((x) => equals(x, a[0]!))),
  index_of: m(1, 1, (l: Value[], a) => l.findIndex((x) => equals(x, a[0]!))),
  first: m(0, 0, (l: Value[]) => (l.length ? l[0]! : null)),
  last: m(0, 0, (l: Value[]) => (l.length ? l[l.length - 1]! : null)),
  clone: m(0, 0, (l: Value[]) => [...l]),
  reverse: m(0, 0, (l: Value[]) => [...l].reverse()),
  join: m(0, 1, (l: Value[], a, sp) => l.map((x) => toStr(x)).join(a.length ? wantString('join', a, 0, sp) : '')),
  slice: m(1, 2, (l: Value[], a, sp) => {
    const [from, to] = sliceBounds('slice', l.length, a, sp);
    return l.slice(from, to);
  }),
  map: m(1, 1, (l: Value[], a, sp, it) => snap(l).map((x, i) => it.callCallback(a[0]!, [x, i], sp, 'map'))),
  filter: m(1, 1, (l: Value[], a, sp, it) => snap(l).filter((x, i) => truthy(it.callCallback(a[0]!, [x, i], sp, 'filter')))),
  find: m(1, 1, (l: Value[], a, sp, it) => snap(l).find((x, i) => truthy(it.callCallback(a[0]!, [x, i], sp, 'find'))) ?? null),
  any: m(1, 1, (l: Value[], a, sp, it) => snap(l).some((x, i) => truthy(it.callCallback(a[0]!, [x, i], sp, 'any')))),
  all: m(1, 1, (l: Value[], a, sp, it) => snap(l).every((x, i) => truthy(it.callCallback(a[0]!, [x, i], sp, 'all')))),
  reduce: m(2, 2, (l: Value[], a, sp, it) => {
    let acc: Value = a[1] ?? null;
    snap(l).forEach((x, i) => { acc = it.callCallback(a[0]!, [acc, x, i], sp, 'reduce'); });
    return acc;
  }),
  is_empty: m(0, 0, (l: Value[]) => l.length === 0),
  sum: m(0, 0, (l: Value[], _a, sp) => {
    let total = 0;
    for (const x of l) {
      if (typeof x !== 'number') throw runtimeError(`«sum» работает только с числами, встретился ${typeName(x)}`, sp);
      total += x;
    }
    return total;
  }),
  avg: m(0, 0, (l: Value[], _a, sp) => {
    if (l.length === 0) throw runtimeError('«avg» не определено для пустого списка — среднее не из чего считать', sp);
    let total = 0;
    for (const x of l) {
      if (typeof x !== 'number') throw runtimeError(`«avg» работает только с числами, встретился ${typeName(x)}`, sp);
      total += x;
    }
    return total / l.length;
  }),
  // Равенство то же, что у contains/index_of. Для простых значений — через Set,
  // для списков и словарей — сравнением по содержимому.
  unique: m(0, 0, (l: Value[]) => {
    const seenPrim = new Set<Value>();
    const seenDeep: Value[] = [];
    const out: Value[] = [];
    for (const x of l) {
      const simple = x === null || typeof x === 'string' || typeof x === 'boolean'
        || (typeof x === 'number' && !Number.isNaN(x));
      if (simple) {
        if (seenPrim.has(x)) continue;
        seenPrim.add(x);
      } else if (Array.isArray(x) || x instanceof Map || x instanceof StructInstance || x instanceof SableRange) {
        if (seenDeep.some((y) => equals(y, x))) continue;
        seenDeep.push(x);
      }
      // nan и функции равны только сами себе по ссылке — их равенство неопределимо, оставляем все.
      out.push(x);
    }
    return out;
  }),
  flatten: m(0, 1, (l: Value[], a, sp) => {
    const depth = a.length ? wantCount('flatten', a, 0, sp) : Infinity;
    // Глубина по умолчанию не ограничена, поэтому кольцо надо ловить самому.
    // При явной глубине сторожить нечего: рекурсия и так конечна.
    const path = new Set<Value[]>();
    const out: Value[] = [];
    const walk = (items: Value[], left: number): void => {
      if (left === Infinity) {
        if (path.has(items)) throw runtimeError('список ссылается сам на себя — «flatten» не может его развернуть', sp);
        path.add(items);
      }
      for (const x of items) {
        if (left > 0 && Array.isArray(x)) walk(x, left - 1);
        else out.push(x);
      }
      path.delete(items);
    };
    walk(l, depth);
    return out;
  }),
  zip: m(1, 1, (l: Value[], a, sp) => zipSeq(l, asSeq('zip', a[0]!, sp))),
  enumerate: m(0, 0, (l: Value[]) => enumerateSeq(l)),
  chunk: m(1, 1, (l: Value[], a, sp) => {
    const n = wantInt('chunk', a, 0, sp);
    if (n <= 0) throw runtimeError(`размер куска в «chunk» должен быть больше нуля, а получен ${n}`, sp);
    const out: Value[] = [];
    for (let i = 0; i < l.length; i += n) out.push(l.slice(i, i + n));
    return out;
  }),
  take: m(1, 1, (l: Value[], a, sp) => l.slice(0, wantCount('take', a, 0, sp))),
  drop: m(1, 1, (l: Value[], a, sp) => l.slice(wantCount('drop', a, 0, sp))),
  // count(f) считает подходящие под условие, count(значение) — равные значению.
  count: m(1, 1, (l: Value[], a, sp, it) => {
    const what = a[0]!;
    if (what instanceof SableFunction || what instanceof NativeFn) {
      let n = 0;
      snap(l).forEach((x, i) => { if (truthy(it.callCallback(what, [x, i], sp, 'count'))) n++; });
      return n;
    }
    return l.filter((x) => equals(x, what)).length;
  }),
  sort_by: m(1, 1, (l: Value[], a, sp, it) => {
    const keyed = snap(l).map((x, i) => ({ x, key: it.callCallback(a[0]!, [x, i], sp, 'sort_by') }));
    // Array.sort устойчива по стандарту: равные ключи сохраняют исходный порядок.
    keyed.sort((p, q) => keyCompare('sort_by', p.key, q.key, sp));
    return keyed.map((p) => p.x);
  }),
  min_by: m(1, 1, (l: Value[], a, sp, it) => extremumBy('min_by', snap(l), a[0]!, sp, it, -1)),
  max_by: m(1, 1, (l: Value[], a, sp, it) => extremumBy('max_by', snap(l), a[0]!, sp, it, 1)),
  group_by: m(1, 1, (l: Value[], a, sp, it) => {
    const out = new Map<MapKey, Value>();
    snap(l).forEach((x, i) => {
      const k = it.callCallback(a[0]!, [x, i], sp, 'group_by');
      if (typeof k !== 'string' && typeof k !== 'number' && typeof k !== 'boolean') {
        throw runtimeError(`функция в «group_by» должна вернуть ключ — строку, число или bool, а вернула ${typeName(k)}`, sp);
      }
      const bucket = out.get(k);
      if (bucket) (bucket as Value[]).push(x);
      else out.set(k, [x]);
    });
    return out;
  }),
  sum_by: m(1, 1, (l: Value[], a, sp, it) => {
    let total = 0;
    snap(l).forEach((x, i) => {
      const v = it.callCallback(a[0]!, [x, i], sp, 'sum_by');
      if (typeof v !== 'number') throw runtimeError(`функция в «sum_by» должна вернуть число, а вернула ${typeName(v)}`, sp);
      total += v;
    });
    return total;
  }),
  partition: m(1, 1, (l: Value[], a, sp, it) => {
    const yes: Value[] = [];
    const no: Value[] = [];
    snap(l).forEach((x, i) => { (truthy(it.callCallback(a[0]!, [x, i], sp, 'partition')) ? yes : no).push(x); });
    return [yes, no];
  }),
  flat_map: m(1, 1, (l: Value[], a, sp, it) => {
    const out: Value[] = [];
    snap(l).forEach((x, i) => {
      const part = it.callCallback(a[0]!, [x, i], sp, 'flat_map');
      if (!Array.isArray(part)) {
        throw runtimeError(`функция в «flat_map» должна вернуть список, а вернула ${typeName(part)} — оберните значение в [ ]`, sp);
      }
      for (const item of part) out.push(item);
    });
    return out;
  }),
  sort: m(0, 1, (l: Value[], a, sp, it) => {
    const copy = [...l];
    if (a.length === 0) return copy.sort((x, y) => defaultCompare(x, y, sp));
    return copy.sort((x, y) => {
      const r = it.callCallback(a[0]!, [x, y], sp, 'sort');
      if (typeof r !== 'number') {
        throw runtimeError(`функция сравнения в sort должна вернуть число, а вернула ${typeName(r)}`, sp);
      }
      return r;
    });
  }),
};

const MAP_METHODS: MethodTable = {
  len: m(0, 0, (mp: Map<MapKey, Value>) => mp.size),
  keys: m(0, 0, (mp: Map<MapKey, Value>) => [...mp.keys()] as Value[]),
  values: m(0, 0, (mp: Map<MapKey, Value>) => [...mp.values()]),
  entries: m(0, 0, (mp: Map<MapKey, Value>) => [...mp.entries()].map(([k, v]) => [k as Value, v])),
  has: m(1, 1, (mp: Map<MapKey, Value>, a, sp) => mp.has(asMapKey(a[0]!, sp))),
  get: m(1, 2, (mp: Map<MapKey, Value>, a, sp) => {
    const k = asMapKey(a[0]!, sp);
    return mp.has(k) ? mp.get(k)! : a.length > 1 ? a[1]! : null;
  }),
  set: m(2, 2, (mp: Map<MapKey, Value>, a, sp) => { mp.set(asMapKey(a[0]!, sp), a[1]!); return mp as Value; }),
  remove: m(1, 1, (mp: Map<MapKey, Value>, a, sp) => {
    const k = asMapKey(a[0]!, sp);
    const had = mp.get(k) ?? null;
    mp.delete(k);
    return had;
  }),
  clone: m(0, 0, (mp: Map<MapKey, Value>) => new Map(mp)),
  merge: m(1, 1, (mp: Map<MapKey, Value>, a, sp) => {
    const other = asMap('merge', a[0]!, sp);
    return new Map([...mp, ...other]);
  }),
  is_empty: m(0, 0, (mp: Map<MapKey, Value>) => mp.size === 0),
  // Колбэк получает (значение, ключ): чаще нужно именно значение, и лямбда с одним параметром получит его.
  map_values: m(1, 1, (mp: Map<MapKey, Value>, a, sp, it) => {
    const out = new Map<MapKey, Value>();
    for (const [k, v] of mp) out.set(k, it.callCallback(a[0]!, [v, k as Value], sp, 'map_values'));
    return out;
  }),
  filter: m(1, 1, (mp: Map<MapKey, Value>, a, sp, it) => {
    const out = new Map<MapKey, Value>();
    for (const [k, v] of mp) {
      if (truthy(it.callCallback(a[0]!, [v, k as Value], sp, 'filter'))) out.set(k, v);
    }
    return out;
  }),
  // Порядок ключей в pick задаёт список, а не исходный словарь: так им удобно раскладывать колонки.
  pick: m(1, 1, (mp: Map<MapKey, Value>, a, sp) => {
    const out = new Map<MapKey, Value>();
    for (const raw of wantList('pick', a, 0, sp)) {
      const k = asMapKey(raw, sp);
      if (mp.has(k)) out.set(k, mp.get(k)!);
    }
    return out;
  }),
  omit: m(1, 1, (mp: Map<MapKey, Value>, a, sp) => {
    const drop = new Set<MapKey>(wantList('omit', a, 0, sp).map((raw) => asMapKey(raw, sp)));
    const out = new Map<MapKey, Value>();
    for (const [k, v] of mp) if (!drop.has(k)) out.set(k, v);
    return out;
  }),
  get_or_insert: m(2, 2, (mp: Map<MapKey, Value>, a, sp) => {
    const k = asMapKey(a[0]!, sp);
    if (mp.has(k)) return mp.get(k)!;
    mp.set(k, a[1]!);
    return a[1]!;
  }),
};

const RANGE_METHODS: MethodTable = {
  len: m(0, 0, (r: SableRange) => r.length),
  list: m(0, 0, (r: SableRange) => r.toList()),
  contains: m(1, 1, (r: SableRange, a, sp) => {
    const n = wantNumber('contains', a, 0, sp);
    // Спрашивают про элемент последовательности, а не про попадание в отрезок:
    // 0..5 — это [0, 1, 2, 3, 4], и 2.5 в него не входит.
    return n >= r.start && n < r.end && Number.isInteger(n - r.start);
  }),
};

/** Предел длины строки: за ним JS бросает свой RangeError, а сообщение у него чужое. */
const MAX_TEXT = 100_000_000;

/** Столько элементов ещё можно построить списком; дальше — просьба, которую не выполнить. */
const MAX_ITEMS = 50_000_000;

export function repeatText(s: string, n: number, span: Span): string {
  if (s.length * n > MAX_TEXT) {
    throw runtimeError(
      `строка из ${s.length * n} символов слишком велика — предел ${MAX_TEXT}`,
      span,
    );
  }
  return s.repeat(n);
}

/** Дополнение строки до нужной длины в символах. */
function padText(s: string, args: Value[], span: Span, fn: string, atStart: boolean): string {
  const want = wantInt(fn, args, 0, span);
  const fill = args.length > 1 ? wantString(fn, args, 1, span) : ' ';
  const chars = [...s];
  if (chars.length >= want || fill === '') return s;
  const padChars = [...fill];
  const need = want - chars.length;
  let pad = '';
  for (let i = 0; i < need; i++) pad += padChars[i % padChars.length];
  return atStart ? pad + s : s + pad;
}

function sliceBounds(fn: string, length: number, args: Value[], span: Span): [number, number] {
  const norm = (n: number) => (n < 0 ? Math.max(0, length + n) : Math.min(n, length));
  const from = norm(wantInt(fn, args, 0, span));
  const to = args.length > 1 ? norm(wantInt(fn, args, 1, span)) : length;
  return [from, Math.max(from, to)];
}

function defaultCompare(a: Value, b: Value, span: Span, fn = 'sort'): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw runtimeError(
    `${fn} без функции сравнения работает только со списком чисел или строк, а встретились ${typeName(a)} и ${typeName(b)}`,
    span,
  );
}

/** Элемент с наименьшим (dir = -1) или наибольшим (dir = 1) ключом. Первый из равных. */
function extremumBy(fn: string, l: Value[], f: Value, span: Span, it: Interpreter, dir: number): Value {
  if (l.length === 0) throw runtimeError(`«${fn}» нужен непустой список`, span);
  let best = l[0]!;
  let bestKey = it.callCallback(f, [best, 0], span, fn);
  for (let i = 1; i < l.length; i++) {
    const key = it.callCallback(f, [l[i]!, i], span, fn);
    if (keyCompare(fn, key, bestKey, span) * dir > 0) { best = l[i]!; bestKey = key; }
  }
  return best;
}

/** Сравнение ключей, вычисленных функцией: sort_by, min_by, max_by. */
function keyCompare(fn: string, a: Value, b: Value, span: Span): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw runtimeError(
    `функция в «${fn}» должна возвращать числа или строки, а вернула ${typeName(a)} и ${typeName(b)}`,
    span,
  );
}

/** Первая буква заглавная, остальное не трогаем: «iPhone» не должен стать «Iphone». */
function capFirst(s: string): string {
  const chars = [...s];
  if (chars.length === 0) return s;
  return chars[0]!.toUpperCase() + chars.slice(1).join('');
}

const TABLES: Array<[(v: Value) => boolean, MethodTable]> = [
  [(v) => typeof v === 'string', STRING_METHODS],
  [(v) => Array.isArray(v), LIST_METHODS],
  [(v) => v instanceof Map, MAP_METHODS],
  [(v) => v instanceof SableRange, RANGE_METHODS],
];

export type MethodEntry = {
  min: number;
  max: number;
  impl: (self: never, args: Value[], span: Span, interp: Interpreter) => Value;
};

/**
 * Реализация метода встроенного типа — без создания объекта-функции.
 * Нужна для `значение.метод(...)`: там результат «привязки» живёт ровно
 * до вызова, и выделять под него объект незачем.
 */
/** Имена методов, доступных значению — для подсказок про опечатку. */
export function methodNames(obj: Value): string[] {
  for (const [matches, table] of TABLES) {
    if (matches(obj)) return Object.keys(table);
  }
  return [];
}

export function findMethodEntry(obj: Value, name: string): MethodEntry | null {
  for (const [matches, table] of TABLES) {
    if (matches(obj)) return table[name] ?? null;
  }
  return null;
}

/** Метод встроенного типа, привязанный к своему значению. Null — если такого метода нет. */
export function getMethod(interp: Interpreter, obj: Value, name: string, span: Span): NativeFn | null {
  for (const [matches, table] of TABLES) {
    if (!matches(obj)) continue;
    const entry = table[name];
    if (!entry) return null;
    return new NativeFn(
      `${typeName(obj)}.${name}`,
      entry.min,
      entry.max,
      (args, callSpan) => entry.impl(obj as never, args, callSpan, interp),
    );
  }
  if (obj instanceof StructDef) {
    const fn = obj.methods.get(name);
    if (fn) {
      throw runtimeError(`«${name}» — метод экземпляра ${obj.name}, вызывать его надо у созданного значения`, span);
    }
  }
  return null;
}
