import { runtimeError, type Span } from './errors.ts';
import type { Value } from './values.ts';

type Slot = { value: Value; mutable: boolean };

/**
 * Область видимости: свои имена плюс ссылка на внешнюю.
 *
 * Хранилище устроено в два яруса, и вот почему. Области создаются очень часто:
 * своя на каждый вызов, своя на каждый виток `for`, своя на каждый блок. При этом
 * почти все они держат ноль или одно имя — переменную цикла, единственный параметр.
 * Поэтому:
 *
 *  - пустой области хранилище не нужно вовсе (тело `while` без объявлений);
 *  - первое имя лежит прямо в полях объекта: ни `Map`, ни отдельного слота;
 *  - `Map` заводится только со второго имени.
 *
 * Поиск от этого тоже выигрывает: пройти цепочку областей — это сравнение строк
 * по ссылке, а не промах в хеш-таблице на каждом уровне.
 *
 * Снаружи всё это не видно: порядок объявления сохраняется (первое имя объявлено
 * первым, значит и в `ownEntries` идёт первым), правила затенения не меняются.
 */
export class Environment {
  /** Первое объявленное здесь имя; null — область пуста. */
  private name0: string | null = null;
  private value0: Value = null;
  private mutable0 = false;
  /** Второе и далее. Заводится только когда имён больше одного. */
  private rest: Map<string, Slot> | null = null;
  parent: Environment | null;
  /** Область встроенных имён: её можно затенить своим объявлением, но не изменить. */
  readonly isBuiltins: boolean;

  constructor(parent: Environment | null = null, isBuiltins = false) {
    this.parent = parent;
    this.isBuiltins = isBuiltins;
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
      if (span) throw this.redeclared(name, span);
      this.value0 = value;
      this.mutable0 = mutable;
      return;
    }
    let rest = this.rest;
    if (rest === null) rest = this.rest = new Map<string, Slot>();
    else if (span && rest.has(name)) throw this.redeclared(name, span);
    rest.set(name, { value, mutable });
  }

  private redeclared(name: string, span: Span): unknown {
    return runtimeError(`«${name}» уже объявлено в этой области видимости`, span);
  }

  /** Имена, объявленные именно здесь (без внешних областей) — экспорт модуля. */
  ownEntries(): Map<string, Value> {
    const out = new Map<string, Value>();
    if (this.name0 !== null) out.set(this.name0, this.value0);
    if (this.rest) for (const [name, slot] of this.rest) out.set(name, slot.value);
    return out;
  }

  has(name: string): boolean {
    if (this.name0 === name) return true;
    if (this.rest !== null && this.rest.has(name)) return true;
    return this.parent?.has(name) ?? false;
  }

  get(name: string, span: Span): Value {
    for (let env: Environment | null = this; env; env = env.parent) {
      if (env.name0 === name) return env.value0;
      const rest = env.rest;
      if (rest !== null) {
        const slot = rest.get(name);
        if (slot) return slot.value;
      }
    }
    throw runtimeError(`имя «${name}» не определено${this.hint(name)}`, span);
  }

  assign(name: string, value: Value, span: Span): void {
    for (let env: Environment | null = this; env; env = env.parent) {
      if (env.name0 === name) {
        if (env.isBuiltins) throw env.builtinAssign(name, span);
        if (!env.mutable0) throw constAssign(name, span);
        env.value0 = value;
        return;
      }
      const slot = env.rest?.get(name);
      if (slot) {
        if (env.isBuiltins) throw env.builtinAssign(name, span);
        if (!slot.mutable) throw constAssign(name, span);
        slot.value = value;
        return;
      }
    }
    throw runtimeError(`нельзя присвоить необъявленному «${name}» — начните со «let ${name} = ...»`, span);
  }

  private builtinAssign(name: string, span: Span): unknown {
    return runtimeError(
      `«${name}» — встроенная функция, присваивать ей нельзя; ` +
      `объявите своё имя: let ${name} = ...`,
      span,
    );
  }

  /** Подсказка про опечатку: ближайшее известное имя по расстоянию Левенштейна. */
  private hint(name: string): string {
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

  /** Имена этой области в порядке объявления. */
  private ownNames(): string[] {
    if (this.name0 === null) return [];
    if (this.rest === null) return [this.name0];
    return [this.name0, ...this.rest.keys()];
  }
}

function constAssign(name: string, span: Span): unknown {
  return runtimeError(`«${name}» объявлено через const — менять нельзя`, span);
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
