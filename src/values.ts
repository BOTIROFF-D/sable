import type { Param, Stmt } from './ast.ts';
import { runtimeError, type Span } from './errors.ts';
import type { Environment } from './environment.ts';

export type MapKey = string | number | boolean;

export class DbgoFunction {
  name: string | null;
  params: Param[];
  body: Stmt[];
  closure: Environment;
  /** Для методов структуры — экземпляр, к которому метод привязан. */
  self: StructInstance | null;

  constructor(name: string | null, params: Param[], body: Stmt[], closure: Environment, self: StructInstance | null = null) {
    this.name = name;
    this.params = params;
    this.body = body;
    this.closure = closure;
    this.self = self;
  }

  bind(self: StructInstance): DbgoFunction {
    return new DbgoFunction(this.name, this.params, this.body, this.closure, self);
  }
}

export type NativeImpl = (args: Value[], span: Span) => Value;

export class NativeFn {
  name: string;
  minArgs: number;
  maxArgs: number;
  impl: NativeImpl;

  constructor(name: string, minArgs: number, maxArgs: number, impl: NativeImpl) {
    this.name = name;
    this.minArgs = minArgs;
    this.maxArgs = maxArgs;
    this.impl = impl;
  }
}

export class DbgoRange {
  start: number;
  end: number;

  constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }

  get length(): number {
    return Math.max(0, Math.ceil(this.end - this.start));
  }

  toList(): Value[] {
    const out: Value[] = [];
    for (let i = this.start; i < this.end; i++) out.push(i);
    return out;
  }
}

export class StructDef {
  name: string;
  fields: Param[];
  methods: Map<string, DbgoFunction>;

  constructor(name: string, fields: Param[], methods: Map<string, DbgoFunction>) {
    this.name = name;
    this.fields = fields;
    this.methods = methods;
  }
}

export class DbgoModule {
  /** Имя, под которым модуль подключён — для сообщений об ошибках. */
  alias: string;
  /** Путь к файлу модуля относительно текущей папки. */
  path: string;
  exports: Map<string, Value>;

  constructor(alias: string, path: string, exports: Map<string, Value>) {
    this.alias = alias;
    this.path = path;
    this.exports = exports;
  }
}

export class StructInstance {
  def: StructDef;
  fields: Map<string, Value>;

  constructor(def: StructDef, fields: Map<string, Value>) {
    this.def = def;
    this.fields = fields;
  }
}

export type Value =
  | number | string | boolean | null
  | Value[]
  | Map<MapKey, Value>
  | DbgoFunction | NativeFn | DbgoRange | StructDef | StructInstance | DbgoModule;

// ---- предикаты и имена типов ---------------------------------------------

export function typeName(v: Value): string {
  if (v === null) return 'nil';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'map';
  if (v instanceof DbgoRange) return 'range';
  if (v instanceof DbgoFunction || v instanceof NativeFn) return 'fn';
  if (v instanceof StructDef) return 'struct';
  if (v instanceof StructInstance) return v.def.name;
  if (v instanceof DbgoModule) return 'module';
  return 'unknown';
}

/** Ложны только false и nil — всё остальное истинно, включая 0 и "". */
export const truthy = (v: Value): boolean => v !== false && v !== null;

export const isCallable = (v: Value): boolean =>
  v instanceof DbgoFunction || v instanceof NativeFn || v instanceof StructDef;

export function equals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equals(x, b[i]!));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !equals(v, b.get(k)!)) return false;
    }
    return true;
  }
  if (a instanceof DbgoRange && b instanceof DbgoRange) return a.start === b.start && a.end === b.end;
  if (a instanceof StructInstance && b instanceof StructInstance) {
    if (a.def !== b.def) return false;
    for (const [k, v] of a.fields) {
      if (!equals(v, b.fields.get(k) ?? null)) return false;
    }
    return true;
  }
  return false;
}

/** Ключ словаря должен быть простым значением — иначе сравнение стало бы непредсказуемым. */
export function asMapKey(v: Value, span: Span): MapKey {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  throw runtimeError(`ключом словаря может быть строка, число или bool, а не ${typeName(v)}`, span);
}

// ---- печать ---------------------------------------------------------------

const numToStr = (n: number): string => {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (Number.isInteger(n)) return String(n);
  return String(n);
};

/** Текст «как для пользователя»: строки без кавычек. */
export function toStr(v: Value, seen: Set<object> = new Set()): string {
  if (typeof v === 'string') return v;
  return repr(v, seen);
}

/** Текст «как в коде»: строки в кавычках, списки и словари развёрнуты. */
export function repr(v: Value, seen: Set<object> = new Set()): string {
  if (v === null) return 'nil';
  if (typeof v === 'number') return numToStr(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

  if (Array.isArray(v)) {
    if (seen.has(v)) return '[...]';
    seen.add(v);
    const s = `[${v.map((x) => repr(x, seen)).join(', ')}]`;
    seen.delete(v);
    return s;
  }
  if (v instanceof Map) {
    if (seen.has(v)) return '{...}';
    seen.add(v);
    const body = [...v.entries()].map(([k, val]) => `${repr(k as Value, seen)}: ${repr(val, seen)}`).join(', ');
    seen.delete(v);
    return `{${body}}`;
  }
  if (v instanceof DbgoRange) return `${numToStr(v.start)}..${numToStr(v.end)}`;
  if (v instanceof DbgoFunction) return `<fn ${v.name ?? 'аноним'}>`;
  if (v instanceof NativeFn) return `<встроенная ${v.name}>`;
  if (v instanceof StructDef) return `<struct ${v.name}>`;
  if (v instanceof DbgoModule) return `<модуль ${v.alias} из ${v.path}>`;
  if (v instanceof StructInstance) {
    if (seen.has(v)) return `${v.def.name}{...}`;
    seen.add(v);
    const body = [...v.fields.entries()].map(([k, val]) => `${k}: ${repr(val, seen)}`).join(', ');
    seen.delete(v);
    return `${v.def.name}{${body}}`;
  }
  return String(v);
}
