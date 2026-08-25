import { runtimeError, type Span } from './errors.ts';
import type { Value } from './values.ts';

type Slot = { value: Value; mutable: boolean };

/**
 * Метка «в этот слот ещё не писали». Нужна отдельная от `nil`: `nil` —
 * законное значение переменной, а необъявленное имя обязано давать ошибку.
 * Слоты области выделяются заранее, поэтому без метки замыкание, созданное выше
 * объявления, читало бы вместо ошибки пустоту.
 */
export const UNSET: unique symbol = Symbol('слот не заполнен');
export type SlotValue = Value | typeof UNSET;

/**
 * Форма локальной области: какие имена в ней объявлены и под какими номерами.
 * Одна на все её экземпляры — на каждый вызов функции, на каждый виток цикла,
 * на каждый вход в блок создаётся только массив значений.
 *
 * Форма известна заранее, потому что расти во время выполнения локальная область
 * не может: всё, что в ней объявляется, видно компилятору — параметры, `self`,
 * `let`/`const`/`fn`/`struct`/`import` прямо в теле, переменная цикла, имя в `catch`.
 */
export type Shape = {
  names: string[];
  index: Map<string, number>;
  mutables: boolean[];
  size: number;
  /** Заготовка для областей пошире: копия плотного массива дешевле, чем заполнение циклом. */
  blank: SlotValue[];
};

export function makeShape(names: string[], mutables: boolean[]): Shape {
  const index = new Map<string, number>();
  for (let i = 0; i < names.length; i++) index.set(names[i]!, i);
  return { names, index, mutables, size: names.length, blank: new Array<SlotValue>(names.length).fill(UNSET) };
}

/** Общий пустой массив слотов для растущих областей — чтобы поле всегда было массивом. */
const NO_SLOTS: SlotValue[] = [];

/**
 * Область видимости: свои имена плюс ссылка на внешнюю.
 *
 * Областей два рода, и это разделение — главное, на чём держится скорость.
 *
 * **Локальная** (тело функции, блок, виток `for`, обработчик `catch`) знает свою
 * форму заранее: имена разобраны на этапе компиляции, обращение к ним идёт по
 * номеру слота, без сравнения строк и без цепочки поиска.
 *
 * **Растущая** (встроенные имена, глобальная область, верхний уровень модуля,
 * поля структуры при подстановке значений по умолчанию) пополняется во время
 * выполнения, поэтому имена там ищутся по имени. Хранилище у неё двухъярусное:
 * почти все такие области держат одно-два имени, поэтому первое лежит прямо в
 * полях объекта, а `Map` заводится только со второго.
 *
 * Поиск по имени умеет проходить и сквозь локальные области — этот путь остаётся
 * для имён, которых компилятор не нашёл ни в одной лексической области, и для
 * подсказок про опечатку.
 */
export class Environment {
  /** Первое объявленное здесь имя растущей области; null — таких имён нет. */
  private name0: string | null = null;
  private value0: Value = null;
  private mutable0 = false;
  /** Второе и далее. Заводится только когда имён больше одного. */
  private rest: Map<string, Slot> | null = null;
  parent: Environment | null;
  /** Область встроенных имён: её можно затенить своим объявлением, но не изменить. */
  readonly isBuiltins: boolean;
  /** Форма локальной области; null — область растёт по ходу выполнения. */
  readonly shape: Shape | null;
  /** Значения по номерам слотов. У растущей области — общий пустой массив. */
  readonly slots: SlotValue[];

  constructor(parent: Environment | null = null, isBuiltins = false, shape: Shape | null = null) {
    this.parent = parent;
    this.isBuiltins = isBuiltins;
    this.shape = shape;
    // Узкие области выписаны литералами не для красоты: литерал массива V8
    // разворачивает из готового образца, а `slice()` — обычный вызов встроенной
    // функции. На цикле `for` из миллиона витков разница вышла в пятую часть
    // всего замера, а областей шире четырёх имён почти не бывает.
    this.slots = shape === null ? NO_SLOTS
      : shape.size === 1 ? [UNSET]
      : shape.size === 2 ? [UNSET, UNSET]
      : shape.size === 3 ? [UNSET, UNSET, UNSET]
      : shape.size === 4 ? [UNSET, UNSET, UNSET, UNSET]
      : shape.blank.slice();
  }

  define(name: string, value: Value, mutable: boolean, span: Span | null = null): void {
    if (this.name0 === null) {
      this.name0 = name;
      this.value0 = value;
      this.mutable0 = mutable;
      return;
    }
    if (this.name0 === name) {
      // Повторное объявление ловится только там, где есть позиция для сообщения:
      // без span (параметр, переменная цикла) объявление всегда первое.
      if (span) throw redeclared(name, span);
      this.value0 = value;
      this.mutable0 = mutable;
      return;
    }
    let rest = this.rest;
    if (rest === null) rest = this.rest = new Map<string, Slot>();
    else if (span && rest.has(name)) throw redeclared(name, span);
    rest.set(name, { value, mutable });
  }

  /** Имена, объявленные именно здесь (без внешних областей) — экспорт модуля. */
  ownEntries(): Map<string, Value> {
    const out = new Map<string, Value>();
    const shape = this.shape;
    if (shape !== null) {
      for (let i = 0; i < shape.names.length; i++) {
        const v = this.slots[i];
        if (v !== UNSET) out.set(shape.names[i]!, v as Value);
      }
    }
    if (this.name0 !== null) out.set(this.name0, this.value0);
    if (this.rest) for (const [name, slot] of this.rest) out.set(name, slot.value);
    return out;
  }

  has(name: string): boolean {
    const shape = this.shape;
    if (shape !== null) {
      const i = shape.index.get(name);
      if (i !== undefined && this.slots[i] !== UNSET) return true;
    }
    if (this.name0 === name) return true;
    if (this.rest !== null && this.rest.has(name)) return true;
    return this.parent?.has(name) ?? false;
  }

  get(name: string, span: Span): Value {
    for (let env: Environment | null = this; env; env = env.parent) {
      const shape = env.shape;
      if (shape !== null) {
        const i = shape.index.get(name);
        if (i !== undefined) {
          const v = env.slots[i];
          // Незаполненный слот — то же самое, что «имени здесь ещё нет»:
          // поиск идёт дальше наружу, как шёл до разбора имён по слотам.
          if (v !== UNSET) return v as Value;
        }
      }
      if (env.name0 === name) return env.value0;
      const rest = env.rest;
      if (rest !== null) {
        const slot = rest.get(name);
        if (slot) return slot.value;
      }
    }
    throw undefinedName(this, name, span);
  }

  /**
   * Поиск имени, которого компилятор не нашёл ни в одной лексической области:
   * оно глобальное, встроенное или из модуля. Первые `up` областей пропускаются
   * не ради экономии на них самих — компилятор уже доказал, что имени там нет,
   * и сравнивать с их именами значит сравнивать заведомо впустую.
   *
   * Подсказка про опечатку считается от места обращения, а не от той области,
   * где поиск закончился: иначе она перестала бы замечать опечатку в локальном
   * имени — ровно там, где она нужнее всего.
   */
  outerGet(up: number, name: string, span: Span): Value {
    let env: Environment | null = this;
    for (let i = 0; i < up; i++) env = env!.parent;
    for (; env !== null; env = env.parent) {
      if (env.name0 === name) return env.value0;
      const rest = env.rest;
      if (rest !== null) {
        const slot = rest.get(name);
        if (slot) return slot.value;
      }
    }
    throw undefinedName(this, name, span);
  }

  /** То же для присваивания: лексические области заведомо не содержат этого имени. */
  outerAssign(up: number, name: string, value: Value, span: Span): void {
    let env: Environment | null = this;
    for (let i = 0; i < up; i++) env = env!.parent;
    for (; env !== null; env = env.parent) {
      if (env.name0 === name) {
        if (env.isBuiltins) throw builtinAssign(name, span);
        if (!env.mutable0) throw constAssign(name, span);
        env.value0 = value;
        return;
      }
      const slot = env.rest?.get(name);
      if (slot) {
        if (env.isBuiltins) throw builtinAssign(name, span);
        if (!slot.mutable) throw constAssign(name, span);
        slot.value = value;
        return;
      }
    }
    throw undeclaredAssign(name, span);
  }

  assign(name: string, value: Value, span: Span): void {
    for (let env: Environment | null = this; env; env = env.parent) {
      const shape = env.shape;
      if (shape !== null) {
        const i = shape.index.get(name);
        if (i !== undefined && env.slots[i] !== UNSET) {
          if (!shape.mutables[i]) throw constAssign(name, span);
          env.slots[i] = value;
          return;
        }
      }
      if (env.name0 === name) {
        if (env.isBuiltins) throw builtinAssign(name, span);
        if (!env.mutable0) throw constAssign(name, span);
        env.value0 = value;
        return;
      }
      const slot = env.rest?.get(name);
      if (slot) {
        if (env.isBuiltins) throw builtinAssign(name, span);
        if (!slot.mutable) throw constAssign(name, span);
        slot.value = value;
        return;
      }
    }
    throw undeclaredAssign(name, span);
  }

  /** Подсказка про опечатку: ближайшее известное имя по расстоянию Левенштейна. */
  hintFor(name: string): string {
    let best: string | null = null;
    let bestDist = Infinity;
    for (let env: Environment | null = this; env; env = env.parent) {
      for (const known of env.ownNames()) {
        const d = distance(name, known);
        if (d < bestDist) { bestDist = d; best = known; }
      }
    }
    const limit = Math.max(1, Math.floor(name.length / 3));
    return best && bestDist <= limit ? ` — возможно, имелось в виду «${best}»` : '';
  }

  /** Имена этой области в порядке объявления; незаполненные слоты ещё не имена. */
  private ownNames(): string[] {
    const out: string[] = [];
    const shape = this.shape;
    if (shape !== null) {
      for (let i = 0; i < shape.names.length; i++) {
        if (this.slots[i] !== UNSET) out.push(shape.names[i]!);
      }
    }
    if (this.name0 !== null) out.push(this.name0);
    if (this.rest !== null) for (const key of this.rest.keys()) out.push(key);
    return out;
  }
}

// ---- тексты ошибок --------------------------------------------------------
//
// Собраны здесь, а не по местам: к слотам и к поиску по имени ведут разные пути,
// а сообщение пользователь обязан видеть одно и то же.

function undefinedName(env: Environment, name: string, span: Span): never {
  throw runtimeError(`имя «${name}» не определено${env.hintFor(name)}`, span);
}

export function constAssign(name: string, span: Span): unknown {
  return runtimeError(`«${name}» объявлено через const — менять нельзя`, span);
}

export function undeclaredAssign(name: string, span: Span): unknown {
  return runtimeError(`нельзя присвоить необъявленному «${name}» — начните со «let ${name} = ...»`, span);
}

export function redeclared(name: string, span: Span): unknown {
  return runtimeError(`«${name}» уже объявлено в этой области видимости`, span);
}

function builtinAssign(name: string, span: Span): unknown {
  return runtimeError(
    `«${name}» — встроенная функция, присваивать ей нельзя; ` +
    `объявите своё имя: let ${name} = ...`,
    span,
  );
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return Infinity;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}
