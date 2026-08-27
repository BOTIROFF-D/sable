import type { Param } from './ast.ts';
import { runtimeError, type Span } from './errors.ts';
import type { Environment, Shape } from './environment.ts';

export type MapKey = string | number | boolean;

/**
 * Скомпилированная функция: тело и значения по умолчанию превращены в замыкания
 * один раз на объявление, а не на каждое создание функции и не на каждый вызов.
 */
export type CompiledFn = {
  /** Тело; возвращает код сигнала (0 — обычный ход, 1 — return, и так далее). */
  run: (env: Environment) => number;
  /** Значения по умолчанию по позициям параметров; null — параметр обязателен. */
  defaults: Array<((env: Environment) => Value) | null>;
  /**
   * Форма области вызова: `self`, параметры и объявления тела по номерам слотов.
   * null — объявлять нечего, и тогда тело выполняется прямо в замкнутой области,
   * без выделения ещё одного объекта на каждый вызов.
   */
  shape: Shape | null;
  /** Куда класть аргументы: номер слота на каждый параметр по порядку. */
  paramSlots: number[];
  /** Номер слота под `self` у метода; -1 — обычная функция. */
  selfSlot: number;
};

export class SableFunction {
  name: string | null;
  params: Param[];
  closure: Environment;
  /** Для методов структуры — экземпляр, к которому метод привязан. */
  self: StructInstance | null;
  /** Сколько параметров без значения по умолчанию — считается один раз, а не на каждый вызов. */
  readonly required: number;
  /** Общая на все экземпляры этой функции скомпилированная часть. */
  readonly code: CompiledFn;

  constructor(
    name: string | null,
    params: Param[],
    code: CompiledFn,
    closure: Environment,
    self: StructInstance | null = null,
  ) {
    this.name = name;
    this.params = params;
    this.code = code;
    this.closure = closure;
    this.self = self;
    this.required = countRequired(params);
  }

  bind(self: StructInstance): SableFunction {
    return new SableFunction(this.name, this.params, this.code, this.closure, self);
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

export class SableRange {
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
  methods: Map<string, SableFunction>;
  /** Сколько полей обязательны — считается один раз, а не на каждое создание экземпляра. */
  readonly required: number;

  /** Значения полей по умолчанию, скомпилированные один раз на объявление. */
  fieldDefaults: Array<((env: Environment) => Value) | null>;

  constructor(
    name: string,
    fields: Param[],
    methods: Map<string, SableFunction>,
    fieldDefaults: Array<((env: Environment) => Value) | null> = fields.map(() => null),
  ) {
    this.name = name;
    this.fields = fields;
    this.methods = methods;
    this.fieldDefaults = fieldDefaults;
    this.required = countRequired(fields);
  }
}

/** Параметры без значения по умолчанию — обязательные. */
function countRequired(params: Param[]): number {
  let n = 0;
  for (let i = 0; i < params.length; i++) if (params[i]!.def === null) n++;
  return n;
}

export class SableModule {
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
  | SableFunction | NativeFn | SableRange | StructDef | StructInstance | SableModule;

// ---- предикаты и имена типов ---------------------------------------------

export function typeName(v: Value): string {
  if (v === null) return 'nil';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'map';
  if (v instanceof SableRange) return 'range';
  if (v instanceof SableFunction || v instanceof NativeFn) return 'fn';
  if (v instanceof StructDef) return 'struct';
  if (v instanceof StructInstance) return v.def.name;
  if (v instanceof SableModule) return 'module';
  return 'unknown';
}

/** Ложны только false и nil — всё остальное истинно, включая 0 и "". */
export const truthy = (v: Value): boolean => v !== false && v !== null;

export const isCallable = (v: Value): boolean =>
  v instanceof SableFunction || v instanceof NativeFn || v instanceof StructDef;

/**
 * Пары значений, которые сравниваются прямо сейчас.
 *
 * Структуры вправе ссылаться друг на друга — двусвязный список, дерево со
 * ссылкой на родителя, граф соседей. Без этой памяти сравнение двух таких
 * узлов уходило в бесконечную рекурсию и роняло стек JS.
 *
 * Пара, встреченная повторно, считается равной: если что-то в глубине их
 * различает, это различие найдётся на другой ветке обхода.
 */
export function equals(a: Value, b: Value, seen?: Map<object, Set<object>>): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;

  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const memo = seen ?? new Map<object, Set<object>>();
    const already = memo.get(a);
    if (already?.has(b)) return true;
    if (already) already.add(b);
    else memo.set(a, new Set([b as object]));
    seen = memo;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    // Обход по индексу, а не every: every пропускает пустые ячейки, и тогда
    // равенство переставало быть симметричным — «a == b» истинно, «b == a» нет.
    for (let i = 0; i < a.length; i++) {
      if (!equals(a[i] ?? null, b[i] ?? null, seen)) return false;
    }
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !equals(v, b.get(k)!, seen)) return false;
    }
    return true;
  }
  if (a instanceof SableRange && b instanceof SableRange) return a.start === b.start && a.end === b.end;
  if (a instanceof StructInstance && b instanceof StructInstance) {
    if (a.def !== b.def) return false;
    for (const [k, v] of a.fields) {
      if (!equals(v, b.fields.get(k) ?? null, seen)) return false;
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

// ---- строка по символам ---------------------------------------------------
//
// Длина и индексы строки считаются в символах (кодовых точках), а не в кодовых
// единицах UTF-16: len("😀") == 1. Прямой способ — [...s] — режет всю строку на
// каждое обращение, то есть s[i] в цикле превращается в O(n²) с выделением
// памяти на каждом шаге. Функции ниже делают то же самое проходом по кодовым
// единицам: без выделения памяти и не дальше нужного места.

/** Стоит ли в позиции i суррогатная пара — то есть занимает ли символ две кодовые единицы. */
function isPair(s: string, i: number): boolean {
  const hi = s.charCodeAt(i);
  if (hi < 0xd800 || hi > 0xdbff || i + 1 >= s.length) return false;
  const lo = s.charCodeAt(i + 1);
  return lo >= 0xdc00 && lo <= 0xdfff;
}

/** Есть ли в строке кодовая единица, которая может открывать суррогатную пару. */
const WIDE = /[\uD800-\uDBFF]/;

/**
 * Строка без суррогатных пар — та, у которой символ равен кодовой единице:
 * по ней можно ходить индексом напрямую. Ответ на этот вопрос запоминается, и
 * не ради микросекунд. Без памяти каждое обращение к символу пересчитывает
 * строку целиком, и обычный посимвольный проход становится квадратичным:
 * лексер Sable, написанный на Sable, разбирал файл в 300 КБ минутами.
 *
 * Помним две последние строки, а не карту: карта в JavaScript сравнивает ключи
 * по содержимому, и две разные строки с одинаковым текстом обходятся ей в
 * полное сравнение на каждый поиск — ровно та цена, которую мы убираем.
 * Двух ячеек хватает на цикл, который идёт сразу по двум строкам.
 *
 * Короткие строки мимо памяти: проверить их заново дешевле, чем занимать место.
 */
const PLAIN_MIN = 64;
const seen = ['', ''];
const wasPlain = [true, true];
let slot = 0;

export function isPlain(s: string): boolean {
  if (s.length < PLAIN_MIN) return !WIDE.test(s);

  for (let i = 0; i < 2; i++) {
    // Длина сначала: она под рукой и отсекает почти все несовпадения даром.
    if (s.length !== seen[i]!.length || s !== seen[i]) continue;
    // Запоминаем именно этот объект. Совпадение могло стоить полного сравнения
    // текстов — две равные, но разные строки JavaScript так и сравнивает,
    // каждый раз заново. Со следующего обращения сравнение будет по ссылке.
    seen[i] = s;
    return wasPlain[i]!;
  }

  const answer = !WIDE.test(s);
  seen[slot] = s;
  wasPlain[slot] = answer;
  slot ^= 1;
  return answer;
}

/** Длина строки в символах. */
export function charLength(s: string): number {
  if (isPlain(s)) return s.length;
  let n = 0;
  for (let i = 0; i < s.length; i += isPair(s, i) ? 2 : 1) n++;
  return n;
}

/**
 * Символы строки списком. Отдельная функция, а не `[...s]` по месту: для строки
 * без суррогатных пар разбивка обходится без итератора по кодовым точкам,
 * который на длинных строках заметно дороже.
 */
export function charsOf(s: string): string[] {
  return isPlain(s) ? s.split('') : [...s];
}

/**
 * Символ по индексу в символах; отрицательный индекс считается с конца.
 * null — индекс вне строки (о длине для сообщения спросит вызывающий).
 */
export function charAt(s: string, index: number): string | null {
  if (isPlain(s)) {
    const i = index < 0 ? index + s.length : index;
    return i >= 0 && i < s.length ? s[i]! : null;
  }
  let want = index;
  if (want < 0) {
    want += charLength(s);
    if (want < 0) return null;
  }
  let seen = 0;
  for (let i = 0; i < s.length; seen++) {
    const wide = isPair(s, i);
    if (seen === want) return wide ? s.slice(i, i + 2) : s[i]!;
    i += wide ? 2 : 1;
  }
  return null;
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
  if (v instanceof SableRange) return `${numToStr(v.start)}..${numToStr(v.end)}`;
  if (v instanceof SableFunction) return `<fn ${v.name ?? 'аноним'}>`;
  if (v instanceof NativeFn) return `<встроенная ${v.name}>`;
  if (v instanceof StructDef) return `<struct ${v.name}>`;
  if (v instanceof SableModule) return `<модуль ${v.alias} из ${v.path}>`;
  if (v instanceof StructInstance) {
    if (seen.has(v)) return `${v.def.name}{...}`;
    seen.add(v);
    const body = [...v.fields.entries()].map(([k, val]) => `${k}: ${repr(val, seen)}`).join(', ');
    seen.delete(v);
    return `${v.def.name}{${body}}`;
  }
  return String(v);
}
