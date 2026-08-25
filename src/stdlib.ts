import { readFileSync, readSync, writeFileSync } from 'node:fs';
import { DbgoError, runtimeError, type Span } from './errors.ts';
import type { Interpreter } from './interpreter.ts';
import {
  NativeFn, DbgoFunction, DbgoRange, StructDef, StructInstance,
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

const arg = (args: Value[], i: number): Value => (i < args.length ? args[i]! : null);

// ---- глобальные функции ---------------------------------------------------

export function installGlobals(interp: Interpreter): void {
  const def = (name: string, min: number, max: number, impl: (a: Value[], s: Span) => Value) => {
    interp.globals.define(name, new NativeFn(name, min, max, impl), false);
  };
  const call = (f: Value, args: Value[], span: Span, who: string): Value => {
    if (!(f instanceof DbgoFunction || f instanceof NativeFn)) {
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
      if (Number.isNaN(n)) {
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
  def('pow', 2, 2, (args, span) => wantNumber('pow', args, 0, span) ** wantNumber('pow', args, 1, span));

  def('round', 1, 2, (args, span) => {
    const n = wantNumber('round', args, 0, span);
    const digits = args.length > 1 ? wantInt('round', args, 1, span) : 0;
    const k = 10 ** digits;
    // Половина округляется от нуля в обе стороны: round(2.5)=3, round(-2.5)=-3.
    return (Math.sign(n) * Math.round(Math.abs(n) * k + Number.EPSILON)) / k;
  });

  def('min', 1, Infinity, (args, span) => extremum('min', args, span, (a, b) => a < b));
  def('max', 1, Infinity, (args, span) => extremum('max', args, span, (a, b) => a > b));

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
    throw new DbgoError('runtime', `assert: ${msg}`, span);
  });

  def('error', 1, 1, (args, span) => {
    const v = arg(args, 0);
    throw new DbgoError('runtime', toStr(v), span, [], v);
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
      return fromPlain(JSON.parse(text));
    } catch (e) {
      if (e instanceof DbgoError) throw e;
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

function asMap(fn: string, v: Value, span: Span): Map<MapKey, Value> {
  if (v instanceof Map) return v;
  throw runtimeError(`«${fn}» ожидает словарь, а получила ${typeName(v)}`, span);
}

function asSeq(fn: string, v: Value, span: Span): Value[] {
  if (Array.isArray(v)) return v;
  if (v instanceof DbgoRange) return v.toList();
  if (typeof v === 'string') return [...v];
  throw runtimeError(`«${fn}» ожидает список, строку или диапазон, а получила ${typeName(v)}`, span);
}

function lengthOf(v: Value, span: Span): number {
  if (typeof v === 'string') return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map) return v.size;
  if (v instanceof DbgoRange) return v.length;
  throw runtimeError(`у значения типа ${typeName(v)} нет длины`, span);
}

function toPlain(v: Value, span: Span): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => toPlain(x, span));
  if (v instanceof DbgoRange) return v.toList().map((x) => toPlain(x, span));
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v) o[String(k)] = toPlain(val, span);
    return o;
  }
  if (v instanceof StructInstance) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v.fields) o[k] = toPlain(val, span);
    return o;
  }
  throw runtimeError(`значение типа ${typeName(v)} нельзя превратить в JSON`, span);
}

function fromPlain(v: unknown): Value {
  if (v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(fromPlain);
  if (typeof v === 'object') {
    const m = new Map<MapKey, Value>();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) m.set(k, fromPlain(val));
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
    return s.repeat(n);
  }),
  pad_start: m(1, 2, (s: string, a, sp) =>
    s.padStart(wantInt('pad_start', a, 0, sp), a.length > 1 ? wantString('pad_start', a, 1, sp) : ' ')),
  pad_end: m(1, 2, (s: string, a, sp) =>
    s.padEnd(wantInt('pad_end', a, 0, sp), a.length > 1 ? wantString('pad_end', a, 1, sp) : ' ')),
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
    if (i < 0 || i > l.length) throw runtimeError(`позиция ${i} вне списка длиной ${l.length}`, sp);
    l.splice(i, 0, a[1]!);
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
  map: m(1, 1, (l: Value[], a, sp, it) => l.map((x, i) => it.callCallback(a[0]!, [x, i], sp, 'map'))),
  filter: m(1, 1, (l: Value[], a, sp, it) => l.filter((x, i) => truthy(it.callCallback(a[0]!, [x, i], sp, 'filter')))),
  find: m(1, 1, (l: Value[], a, sp, it) => l.find((x, i) => truthy(it.callCallback(a[0]!, [x, i], sp, 'find'))) ?? null),
  any: m(1, 1, (l: Value[], a, sp, it) => l.some((x, i) => truthy(it.callCallback(a[0]!, [x, i], sp, 'any')))),
  all: m(1, 1, (l: Value[], a, sp, it) => l.every((x, i) => truthy(it.callCallback(a[0]!, [x, i], sp, 'all')))),
  reduce: m(2, 2, (l: Value[], a, sp, it) => {
    let acc: Value = a[1] ?? null;
    l.forEach((x, i) => { acc = it.callCallback(a[0]!, [acc, x, i], sp, 'reduce'); });
    return acc;
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
};

const RANGE_METHODS: MethodTable = {
  len: m(0, 0, (r: DbgoRange) => r.length),
  list: m(0, 0, (r: DbgoRange) => r.toList()),
  contains: m(1, 1, (r: DbgoRange, a, sp) => {
    const n = wantNumber('contains', a, 0, sp);
    return n >= r.start && n < r.end;
  }),
};

function sliceBounds(fn: string, length: number, args: Value[], span: Span): [number, number] {
  const norm = (n: number) => (n < 0 ? Math.max(0, length + n) : Math.min(n, length));
  const from = norm(wantInt(fn, args, 0, span));
  const to = args.length > 1 ? norm(wantInt(fn, args, 1, span)) : length;
  return [from, Math.max(from, to)];
}

function defaultCompare(a: Value, b: Value, span: Span): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw runtimeError(
    `sort без функции сравнения работает только со списком чисел или строк, а встретились ${typeName(a)} и ${typeName(b)}`,
    span,
  );
}

const TABLES: Array<[(v: Value) => boolean, MethodTable]> = [
  [(v) => typeof v === 'string', STRING_METHODS],
  [(v) => Array.isArray(v), LIST_METHODS],
  [(v) => v instanceof Map, MAP_METHODS],
  [(v) => v instanceof DbgoRange, RANGE_METHODS],
];

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
