import { runtimeError, type Span } from './errors.ts';
import type { Value } from './values.ts';

type Slot = { value: Value; mutable: boolean };

/** Область видимости: своя таблица имён плюс ссылка на внешнюю. */
export class Environment {
  private slots = new Map<string, Slot>();
  parent: Environment | null;

  constructor(parent: Environment | null = null) {
    this.parent = parent;
  }

  define(name: string, value: Value, mutable: boolean, span: Span | null = null): void {
    if (this.slots.has(name) && span) {
      throw runtimeError(`«${name}» уже объявлено в этой области видимости`, span);
    }
    this.slots.set(name, { value, mutable });
  }

  /** Имена, объявленные именно здесь (без внешних областей) — экспорт модуля. */
  ownEntries(): Map<string, Value> {
    const out = new Map<string, Value>();
    for (const [name, slot] of this.slots) out.set(name, slot.value);
    return out;
  }

  has(name: string): boolean {
    return this.slots.has(name) || (this.parent?.has(name) ?? false);
  }

  get(name: string, span: Span): Value {
    for (let env: Environment | null = this; env; env = env.parent) {
      const slot = env.slots.get(name);
      if (slot) return slot.value;
    }
    throw runtimeError(`имя «${name}» не определено${this.hint(name)}`, span);
  }

  assign(name: string, value: Value, span: Span): void {
    for (let env: Environment | null = this; env; env = env.parent) {
      const slot = env.slots.get(name);
      if (slot) {
        if (!slot.mutable) throw runtimeError(`«${name}» объявлено через const — менять нельзя`, span);
        slot.value = value;
        return;
      }
    }
    throw runtimeError(`нельзя присвоить необъявленному «${name}» — начните со «let ${name} = ...»`, span);
  }

  /** Подсказка про опечатку: ближайшее известное имя по расстоянию Левенштейна. */
  private hint(name: string): string {
    let best: string | null = null;
    let bestDist = Infinity;
    for (let env: Environment | null = this; env; env = env.parent) {
      for (const known of env.slots.keys()) {
        const d = distance(name, known);
        if (d < bestDist) { bestDist = d; best = known; }
      }
    }
    const limit = Math.max(1, Math.floor(name.length / 3));
    return best && bestDist <= limit ? ` — возможно, имелось в виду «${best}»` : '';
  }
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
