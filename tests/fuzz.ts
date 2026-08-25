#!/usr/bin/env node
// tests/fuzz.ts — генератор случайных программ на sable и охотник за сбоями.
//
// Зачем: golden-тесты проверяют то, о чём мы уже подумали. Фаззер ищет то,
// о чём не подумал никто: он строит СИНТАКСИЧЕСКИ КОРРЕКТНЫЕ программы
// (иначе мы бы тестировали только парсер), запускает их и смотрит, не вылезло ли
// наружу что-то, чего пользователь видеть не должен.
//
// Что считается дефектом (см. classify):
//   1. сбой            — процесс упал не по-sable: сигнал, чужой код возврата, OOM;
//   2. зависание       — не уложился в таймаут либо льёт бесконечный вывод;
//                        единственный класс, который нужно разбирать глазами:
//                        случайная программа имеет право быть долгой сама по себе,
//                        а дефект — это цикл, который не может кончиться в принципе
//                        (например «for i in (0-inf)..0»: i++ не двигает -inf);
//   3. js-внутренности — в выводе стек JavaScript, RangeError, TypeError и т.п.;
//   4. undefined       — в выводе «undefined», «[object Object]», «NaN», тип «unknown»;
//   5. инвариант       — программа сама поймала нарушение (печатает метку ИНВАРИАНТ:);
//   6. ложная тревога  — «--check» нашёл ОШИБКУ, а программа отработала чисто;
//   7. пропуск         — «--check» промолчал, а программа упала на том,
//                        что анализатор обязан был увидеть.
//
// Пункт 6 возможен потому, что генератор по построению не пишет некорректный код:
// он не ссылается на необъявленные имена, не путает число аргументов, не пишет
// в const, не ставит break вне цикла. Значит любая ОШИБКА (не замечание) от
// «--check» на чистом прогоне — ложная тревога.
//
// Запуск:
//   node tests/fuzz.ts                       — 300 программ со случайным зерном
//   node tests/fuzz.ts --seed=123            — воспроизвести прогон
//   node tests/fuzz.ts --count=50 --timeout=3000
//   node tests/fuzz.ts --only=42             — сгенерировать и напечатать одну программу
//
// Найденное сокращается автоматически (жадное удаление сбалансированных кусков)
// и складывается в tests/fuzz-findings/.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FINDINGS = join(HERE, 'fuzz-findings');

// ---- разбор аргументов -----------------------------------------------------

const argOf = (name: string, def: number): number => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw === undefined ? def : Number(raw.slice(name.length + 3));
};

const argStr = (name: string, def: string): string => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw === undefined ? def : raw.slice(name.length + 3);
};

/**
 * Где лежит язык, который проверяем. По умолчанию — этот же репозиторий,
 * но «--root=/путь/к/копии» позволяет охотиться на заведомо рабочем срезе,
 * пока в рабочей папке идёт переработка интерпретатора.
 */
export const ROOT = argStr('root', join(HERE, '..'));
const CLI = join(ROOT, 'src', 'cli.ts');

const SEED = argOf('seed', (Math.random() * 0xffffffff) >>> 0);
const COUNT = argOf('count', 300);
const TIMEOUT = argOf('timeout', 5000);
const JOBS = argOf('jobs', 8);
const ONLY = process.argv.some((a) => a.startsWith('--only=')) ? argOf('only', 0) : null;
/**
 * Сколько запусков разрешено потратить на сокращение одного примера.
 * Крупная программа (200+ строк) в этот бюджет может не уложиться —
 * тогда стоит повторить находку с «--shrink=800».
 */
const SHRINK_BUDGET = argOf('shrink', 400);

// ---- генератор случайных чисел --------------------------------------------

/** mulberry32: короткий, быстрый и воспроизводимый — одно зерно даёт один и тот же прогон. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rnd {
  next: () => number;

  constructor(seed: number) {
    this.next = makeRandom(seed);
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Сколько раз повторить: от lo до hi включительно. */
  times(lo: number, hi: number): number[] {
    const n = lo + this.int(hi - lo + 1);
    return Array.from({ length: n }, (_, i) => i);
  }
}

// ---- генератор программ ----------------------------------------------------

type Ty = 'number' | 'string' | 'bool' | 'list' | 'map' | 'any';

type VarInfo = {
  name: string;
  ty: Ty;
  mutable: boolean;
  /** Счётчик while: присваивать ему что попало нельзя — цикл станет вечным. */
  counter?: boolean;
};
type FnInfo = { name: string; min: number; max: number };
type StructInfo = { name: string; fields: string[]; min: number; max: number; methods: string[] };

/** Имена берутся из общего счётчика — так две переменные никогда не совпадут. */
const NUM_LITERALS = [
  '0', '1', '2', '-1', '3.5', '-0.5', '10', '100', '1_000', '0xFF', '1e3',
  '0.1', '7', '-3', '1e308', '2.5', '1e-7',
];
const STR_LITERALS = [
  '"привет"', '"Ali"', '""', '"  пробелы  "', '"a,b,c"', '"строка\\nвторая"',
  '"oʻquvchi"', '"\\u{1F600}"', '"ABC"', '"абв"', '"{}"', '`много строк`',
];
// Многострочный литерал в пул намеренно не входит: сокращатель работает по
// строкам, а строка исходника, оборванная посреди `…`, ломает счёт скобок.

export class Gen {
  r: Rnd;
  /** Все видимые сейчас имена; при выходе из блока хвост отрезается. */
  vars: VarInfo[] = [];
  fns: FnInfo[] = [];
  structs: StructInfo[] = [];
  counter = 0;
  loopDepth = 0;
  fnDepth = 0;
  /** Внутри try можно рисковать: ошибка не убьёт программу. */
  risky = false;
  /** Имена функций, объявление которых отложено на конец программы. */
  late: string[] = [];

  constructor(r: Rnd) {
    this.r = r;
  }

  name(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  varsOf(ty: Ty): VarInfo[] {
    return this.vars.filter((v) => v.ty === ty);
  }

  /** Выполнить построение в своей области видимости: объявленное внутри снаружи не видно. */
  scoped<T>(build: () => T): T {
    const vs = this.vars.length;
    const fs = this.fns.length;
    const ss = this.structs.length;
    const out = build();
    this.vars.length = vs;
    this.fns.length = fs;
    this.structs.length = ss;
    return out;
  }

  // ---- выражения -----------------------------------------------------------

  expr(ty: Ty, d: number): string {
    switch (ty) {
      case 'number': return this.num(d);
      case 'string': return this.str(d);
      case 'bool': return this.bool(d);
      case 'list': return this.list(d);
      case 'map': return this.map(d);
      default: return this.any(d);
    }
  }

  num(d: number): string {
    const vs = this.varsOf('number');
    if (d <= 0) return vs.length && this.r.chance(0.4) ? this.r.pick(vs).name : this.r.pick(NUM_LITERALS);
    const forms: Array<() => string> = [
      () => this.r.pick(NUM_LITERALS),
      () => (vs.length ? this.r.pick(vs).name : this.r.pick(NUM_LITERALS)),
      () => `(${this.num(d - 1)} ${this.r.pick(['+', '-', '*'])} ${this.num(d - 1)})`,
      () => `(${this.num(d - 1)} ^ ${this.r.pick(['2', '3', '-1', '0.5'])})`,
      () => `len(${this.expr(this.r.pick(['list', 'string', 'map'] as const), d - 1)})`,
      () => `${this.r.pick(['abs', 'floor', 'ceil', 'int', 'sign', 'round'])}(${this.num(d - 1)})`,
      () => `min(${this.num(d - 1)}, ${this.num(d - 1)})`,
      () => `max(${this.num(d - 1)}, ${this.num(d - 1)})`,
      () => `num(${this.str(d - 1)}, 0)`,
      () => `(${this.bool(d - 1)} ? ${this.num(d - 1)} : ${this.num(d - 1)})`,
      () => `${this.list(d - 1)}.len()`,
      () => `${this.list(d - 1)}.count(${this.num(d - 1)})`,
      () => `(${this.num(d - 1)} ?? 0)`,
    ];
    // Рискованное — только под try: там ошибка ожидаема и не рвёт программу.
    if (this.risky) {
      forms.push(
        () => `(${this.num(d - 1)} / ${this.num(d - 1)})`,
        () => `(${this.num(d - 1)} % ${this.num(d - 1)})`,
        () => `${this.list(d - 1)}.sum()`,
        () => `${this.list(d - 1)}.avg()`,
        () => `sqrt(${this.num(d - 1)})`,
        () => `log(${this.num(d - 1)})`,
        () => `${this.list(d - 1)}[${this.num(d - 1)}]`,
      );
    }
    return this.r.pick(forms)();
  }

  str(d: number): string {
    const vs = this.varsOf('string');
    if (d <= 0) return vs.length && this.r.chance(0.4) ? this.r.pick(vs).name : this.r.pick(STR_LITERALS);
    const simple = vs.length ? this.r.pick(vs).name : this.r.pick(NUM_LITERALS);
    const forms: Array<() => string> = [
      () => this.r.pick(STR_LITERALS),
      () => (vs.length ? this.r.pick(vs).name : this.r.pick(STR_LITERALS)),
      // Внутри ${...} намеренно только простое имя или литерал: так сокращатель
      // может считать скобки, не разбирая строки целиком.
      () => `"значение ${'${'}${simple}${'}'} тут"`,
      () => `str(${this.any(d - 1)})`,
      () => `repr(${this.any(d - 1)})`,
      () => `type(${this.any(d - 1)})`,
      () => `${this.str(d - 1)}.${this.r.pick(['upper', 'lower', 'trim', 'reverse', 'capitalize', 'title', 'trim_start'])}()`,
      () => `(${this.str(d - 1)} + ${this.str(d - 1)})`,
      () => `${this.str(d - 1)}.replace(${this.str(d - 1)}, ${this.str(d - 1)})`,
      () => `${this.list(d - 1)}.join(",")`,
      () => `${this.str(d - 1)}.pad_start(4, "0")`,
      () => `to_json(${this.any(d - 1)})`,
    ];
    if (this.risky) {
      forms.push(
        () => `${this.str(d - 1)}.slice(${this.num(d - 1)})`,
        () => `${this.str(d - 1)}.repeat(${this.num(d - 1)})`,
        () => `(${this.str(d - 1)} * ${this.num(d - 1)})`,
        () => `${this.str(d - 1)}[${this.num(d - 1)}]`,
        () => `${this.str(d - 1)}.format(${this.any(d - 1)})`,
      );
    }
    return this.r.pick(forms)();
  }

  bool(d: number): string {
    const vs = this.varsOf('bool');
    if (d <= 0) return vs.length && this.r.chance(0.4) ? this.r.pick(vs).name : this.r.pick(['true', 'false']);
    const forms: Array<() => string> = [
      () => this.r.pick(['true', 'false']),
      () => (vs.length ? this.r.pick(vs).name : 'true'),
      () => `(${this.num(d - 1)} ${this.r.pick(['<', '<=', '>', '>=', '==', '!='])} ${this.num(d - 1)})`,
      () => `(${this.any(d - 1)} == ${this.any(d - 1)})`,
      () => `!(${this.bool(d - 1)})`,
      () => `(${this.bool(d - 1)} ${this.r.pick(['&&', '||', 'and', 'or'])} ${this.bool(d - 1)})`,
      () => `${this.list(d - 1)}.contains(${this.any(d - 1)})`,
      () => `${this.list(d - 1)}.is_empty()`,
      () => `${this.map(d - 1)}.has(${this.str(d - 1)})`,
      () => `(type(${this.any(d - 1)}) == "list")`,
      () => `bool(${this.any(d - 1)})`,
      () => `${this.list(d - 1)}.all(x -> ${this.r.chance(0.5) ? 'true' : `type(x) == "number"`})`,
    ];
    return this.r.pick(forms)();
  }

  list(d: number): string {
    const vs = this.varsOf('list');
    if (d <= 0) {
      if (vs.length && this.r.chance(0.5)) return this.r.pick(vs).name;
      return `[${this.r.times(0, 3).map(() => this.r.pick(NUM_LITERALS)).join(', ')}]`;
    }
    const forms: Array<() => string> = [
      () => `[${this.r.times(0, 3).map(() => this.any(d - 1)).join(', ')}]`,
      () => (vs.length ? this.r.pick(vs).name : `[1, 2, 3]`),
      () => `range(${this.r.int(4)}, ${this.r.int(6)})`,
      () => `(${this.r.int(3)}..${this.r.int(7)}).list()`,
      () => `${this.list(d - 1)}.map(x -> ${this.lambdaBody(d - 1)})`,
      () => `${this.list(d - 1)}.filter(x -> ${this.r.chance(0.5) ? 'true' : `type(x) == "number"`})`,
      () => `${this.list(d - 1)}.${this.r.pick(['reverse', 'clone', 'unique', 'enumerate'])}()`,
      () => `${this.list(d - 1)}.${this.r.pick(['take', 'drop'])}(${this.r.int(4)})`,
      () => `${this.list(d - 1)}.chunk(${1 + this.r.int(3)})`,
      () => `${this.list(d - 1)}.flatten(${this.r.int(2)})`,
      () => `${this.list(d - 1)}.partition(x -> type(x) == "number")`,
      () => `${this.list(d - 1)}.zip(${this.list(d - 1)})`,
      () => `keys(${this.map(d - 1)})`,
      () => `values(${this.map(d - 1)})`,
      () => `entries(${this.map(d - 1)})`,
      () => `${this.str(d - 1)}.chars()`,
      () => `${this.str(d - 1)}.split(",")`,
      () => `reversed(${this.list(d - 1)})`,
      () => `${this.list(d - 1)}.sort_by(x -> type(x))`,
    ];
    if (this.risky) {
      forms.push(
        () => `${this.list(d - 1)}.sort()`,
        () => `sorted(${this.list(d - 1)})`,
        () => `${this.list(d - 1)}.flatten()`,
        () => `${this.list(d - 1)}.slice(${this.num(d - 1)})`,
        () => `${this.list(d - 1)}.flat_map(x -> [x])`,
        () => `(${this.list(d - 1)} * ${this.num(d - 1)})`,
        () => `(${this.list(d - 1)} + ${this.list(d - 1)})`,
        // Колбэк, меняющий тот же список, — отдельная охота: так ловятся дыры в массиве.
        () => {
          const v = vs.length ? this.r.pick(vs).name : null;
          return v === null
            ? `${this.list(d - 1)}.map(x -> x)`
            : `${v}.map(x -> ${this.r.chance(0.5) ? `${v}.pop()` : `${v}.push(x)`})`;
        },
      );
    }
    return this.r.pick(forms)();
  }

  // Литерал словаря всегда в скобках: в заголовке if/while/for голая «{»
  // читается как начало тела — это правило языка, а не дефект.
  map(d: number): string {
    const vs = this.varsOf('map');
    if (d <= 0) {
      if (vs.length && this.r.chance(0.5)) return this.r.pick(vs).name;
      return `({ a: 1, b: "два" })`;
    }
    const forms: Array<() => string> = [
      () => `({ ${this.r.times(1, 3).map((i) => `${this.r.pick(['a', 'b', 'c', 'ключ', 'd'])}${i}: ${this.any(d - 1)}`).join(', ')} })`,
      () => (vs.length ? this.r.pick(vs).name : `({ a: 1 })`),
      () => `${this.map(d - 1)}.clone()`,
      () => `${this.map(d - 1)}.merge(${this.map(d - 1)})`,
      () => `${this.map(d - 1)}.map_values(v -> ${this.r.chance(0.5) ? 'v' : `type(v)`})`,
      () => `${this.map(d - 1)}.filter(v -> type(v) == "number")`,
      () => `${this.map(d - 1)}.pick([${this.str(d - 1)}])`,
      () => `${this.map(d - 1)}.omit([${this.str(d - 1)}])`,
      () => `${this.list(d - 1)}.group_by(x -> type(x))`,
      () => `({ [${this.r.chance(0.5) ? this.str(d - 1) : this.num(d - 1)}]: ${this.any(d - 1)} })`,
    ];
    if (this.risky) {
      forms.push(
        () => `from_entries(zip(${this.list(d - 1)}, ${this.list(d - 1)}))`,
        () => `from_json(to_json(${this.map(d - 1)}))`,
      );
    }
    return this.r.pick(forms)();
  }

  /** Тело короткой лямбды: выражение, а не блок. */
  lambdaBody(d: number): string {
    return this.r.pick([
      () => 'x',
      () => `type(x)`,
      () => `[x]`,
      () => `str(x)`,
      () => `(x == x)`,
      () => `repr(x)`,
      () => `${this.any(Math.max(0, d - 1))}`,
    ])();
  }

  any(d: number): string {
    const forms: Array<() => string> = [
      () => this.num(d),
      () => this.str(d),
      () => this.bool(d),
      () => 'nil',
    ];
    if (d > 0) {
      forms.push(
        () => this.list(d - 1),
        () => this.map(d - 1),
        () => `(${this.num(d - 1)}..${this.num(d - 1)})`,
        () => `(x -> x)`,
        () => `fn(a, b = 1) -> ${this.r.chance(0.5) ? 'a' : 'b'}`,
      );
      if (this.structs.length) {
        forms.push(() => {
          const s = this.r.pick(this.structs);
          const args = Array.from({ length: s.max }, () => this.any(d - 1));
          return `${s.name}(${args.join(', ')})`;
        });
      }
      if (this.fns.length) {
        forms.push(() => {
          const f = this.r.pick(this.fns);
          const args = Array.from({ length: f.max }, () => this.any(d - 1));
          return `${f.name}(${args.join(', ')})`;
        });
      }
      const vs = this.vars;
      if (vs.length) forms.push(() => this.r.pick(vs).name);
    }
    return this.r.pick(forms)();
  }

  // ---- инструкции ----------------------------------------------------------

  /** Одна инструкция как набор строк с отступом. */
  statement(indent: string, d: number, out: string[]): void {
    const forms: Array<() => void> = [
      () => this.declare(indent, d, out),
      () => this.printStmt(indent, d, out),
      () => this.probe(indent, d, out),
      () => this.ifStmt(indent, d, out),
      () => this.forStmt(indent, d, out),
      () => this.whileStmt(indent, d, out),
      () => this.tryStmt(indent, d, out),
      () => this.assignStmt(indent, d, out),
      () => this.mutateStmt(indent, d, out),
    ];
    if (this.fnDepth < 2) forms.push(() => this.fnDecl(indent, d, out));
    this.r.pick(forms)();
  }

  /** Объявление переменной: инициализатор безопасный, иначе программа умрёт на первой строке. */
  declare(indent: string, d: number, out: string[]): void {
    const ty = this.r.pick(['number', 'string', 'bool', 'list', 'map'] as const);
    const mutable = this.r.chance(0.7);
    const name = this.name(this.r.pick(['v', 'x', 'знач', 'oʻz']));
    const prev = this.risky;
    this.risky = false;
    out.push(`${indent}${mutable ? 'let' : 'const'} ${name} = ${this.expr(ty, Math.min(d, 2))}`);
    this.risky = prev;
    this.vars.push({ name, ty, mutable });
  }

  printStmt(indent: string, d: number, out: string[]): void {
    const args = this.r.times(1, 3).map(() => this.any(d));
    out.push(`${indent}print(${args.join(', ')})`);
  }

  assignStmt(indent: string, d: number, out: string[]): void {
    // Счётчики циклов не трогаем: перезаписав счётчик, генератор сделал бы
    // вечный цикл и сам себе подсунул «зависание», которого в языке нет.
    const targets = this.vars.filter((v) => v.mutable && !v.counter);
    if (targets.length === 0) return this.printStmt(indent, d, out);
    const v = this.r.pick(targets);
    if (v.ty === 'number' && this.r.chance(0.5)) {
      out.push(`${indent}${v.name} ${this.r.pick(['+=', '-=', '*='])} ${this.num(Math.min(d, 2))}`);
      return;
    }
    out.push(`${indent}${v.name} = ${this.expr(v.ty, Math.min(d, 2))}`);
  }

  /** Изменение на месте: push/pop/set/удаление — то, где ломаются инварианты длины. */
  mutateStmt(indent: string, d: number, out: string[]): void {
    const lists = this.varsOf('list');
    const maps = this.varsOf('map');
    if (lists.length && this.r.chance(0.6)) {
      const v = this.r.pick(lists).name;
      out.push(`${indent}${v}.${this.r.pick([
        `push(${this.any(d)})`,
        `push(${this.any(d)}, ${this.any(d)})`,
        `insert(0, ${this.any(d)})`,
      ])}`);
      return;
    }
    if (maps.length) {
      const v = this.r.pick(maps).name;
      out.push(`${indent}${v}.${this.r.pick([
        `set(${this.str(d)}, ${this.any(d)})`,
        `get_or_insert(${this.str(d)}, ${this.any(d)})`,
        `remove(${this.str(d)})`,
      ])}`);
      return;
    }
    this.printStmt(indent, d, out);
  }

  ifStmt(indent: string, d: number, out: string[]): void {
    out.push(`${indent}if ${this.bool(Math.min(d, 2))} {`);
    this.scoped(() => this.body(indent + '  ', d, out));
    if (this.r.chance(0.4)) {
      out.push(`${indent}} else {`);
      this.scoped(() => this.body(indent + '  ', d, out));
    }
    out.push(`${indent}}`);
  }

  forStmt(indent: string, d: number, out: string[]): void {
    const name = this.name('i');
    const seq = this.r.pick([
      () => `${this.r.int(3)}..${this.r.int(5)}`,
      () => this.list(Math.min(d, 2)),
      () => `${this.map(Math.min(d, 2))}`,
      () => this.str(Math.min(d, 2)),
      // Границы-выражения: так находятся диапазоны, которые нельзя пройти.
      () => `${this.num(1)}..${this.num(1)}`,
    ])();
    out.push(`${indent}for ${name} in ${seq} {`);
    this.loopDepth += 1;
    this.scoped(() => {
      this.vars.push({ name, ty: 'any', mutable: true });
      this.body(indent + '  ', d, out);
      this.maybeJump(indent + '  ', out);
    });
    this.loopDepth -= 1;
    out.push(`${indent}}`);
  }

  /** while со счётчиком: бесконечный цикл в генераторе — это шум, а не находка. */
  whileStmt(indent: string, d: number, out: string[]): void {
    const name = this.name('k');
    out.push(`${indent}let ${name} = 0`);
    out.push(`${indent}while ${name} < ${1 + this.r.int(4)} {`);
    this.loopDepth += 1;
    this.scoped(() => {
      this.vars.push({ name, ty: 'number', mutable: true, counter: true });
      out.push(`${indent}  ${name} += 1`);
      this.body(indent + '  ', d, out);
      this.maybeJump(indent + '  ', out);
    });
    this.loopDepth -= 1;
    out.push(`${indent}}`);
    this.vars.push({ name, ty: 'number', mutable: true, counter: true });
  }

  /** break/continue — только там, где язык их разрешает: не через границу функции. */
  maybeJump(indent: string, out: string[]): void {
    if (this.loopDepth === 0 || !this.r.chance(0.25)) return;
    out.push(`${indent}if ${this.bool(1)} { ${this.r.pick(['break', 'continue'])} }`);
  }

  tryStmt(indent: string, d: number, out: string[]): void {
    out.push(`${indent}try {`);
    const prev = this.risky;
    this.risky = true;
    this.scoped(() => {
      this.body(indent + '  ', d, out);
      if (this.r.chance(0.3)) out.push(`${indent}  error(${this.any(Math.min(d, 2))})`);
    });
    this.risky = prev;
    if (this.r.chance(0.7)) {
      const e = this.name('e');
      out.push(`${indent}} catch ${e} {`);
      this.scoped(() => {
        this.vars.push({ name: e, ty: 'map', mutable: false });
        out.push(`${indent}  print("поймано:", ${e}.message, type(${e}.value))`);
      });
    } else {
      out.push(`${indent}} catch {`);
    }
    out.push(`${indent}}`);
  }

  fnDecl(indent: string, d: number, out: string[]): void {
    const name = this.name('f');
    const params = this.r.times(0, 2).map((i) => `p${i}`);
    const withDefault = params.length > 0 && this.r.chance(0.4);
    const head = params.map((p, i) => (withDefault && i === params.length - 1 ? `${p} = 1` : p));
    out.push(`${indent}fn ${name}(${head.join(', ')}) {`);
    this.fnDepth += 1;
    const savedLoop = this.loopDepth;
    this.loopDepth = 0; // break внутри функции до внешнего цикла не долетает
    this.scoped(() => {
      for (const p of params) this.vars.push({ name: p, ty: 'any', mutable: true });
      this.body(indent + '  ', Math.min(d, 2), out);
      out.push(`${indent}  return ${this.any(Math.min(d, 2))}`);
    });
    this.loopDepth = savedLoop;
    this.fnDepth -= 1;
    out.push(`${indent}}`);
    this.fns.push({ name, min: params.length - (withDefault ? 1 : 0), max: params.length });
  }

  structDecl(out: string[]): void {
    const name = this.name('S');
    const fields = this.r.times(1, 3).map((i) => `поле${i}`);
    const withDefault = this.r.chance(0.4);
    out.push(`struct ${name} {`);
    fields.forEach((f, i) => {
      out.push(`  ${f}${withDefault && i === fields.length - 1 ? ' = 0' : ''}`);
    });
    const methods: string[] = [];
    for (const _ of this.r.times(0, 2)) {
      const mName = this.name('м');
      methods.push(mName);
      out.push(`  fn ${mName}() {`);
      out.push(`    return self.${this.r.pick(fields)}`);
      out.push(`  }`);
    }
    out.push(`}`);
    this.structs.push({ name, fields, min: fields.length - (withDefault ? 1 : 0), max: fields.length, methods });
  }

  /**
   * Проверки инвариантов языка. Программа сама себя ловит и печатает метку —
   * так фаззеру не нужно знать, каким должен быть правильный вывод.
   */
  probe(indent: string, d: number, out: string[]): void {
    const p = this.r.int(7);
    const a = this.name('a');
    const b = this.name('b');
    const n = this.name('n');
    const push = (line: string) => out.push(indent + line);

    push('try {');
    if (p === 0) {
      // Значение равно самому себе, и его тип осмыслен.
      push(`  let ${a} = ${this.any(Math.min(d, 2))}`);
      push(`  if !(${a} == ${a}) { print("ИНВАРИАНТ: значение не равно самому себе:", repr(${a})) }`);
      push(`  if type(${a}) == "unknown" { print("ИНВАРИАНТ: тип unknown у", repr(${a})) }`);
      push(`  str(${a}); repr(${a})`);
    } else if (p === 1) {
      // len(список) совпадает с числом элементов при обходе.
      push(`  let ${a} = ${this.list(Math.min(d, 2))}`);
      push(`  let ${n} = 0`);
      push(`  for _e in ${a} { ${n} += 1 }`);
      push(`  if len(${a}) != ${n} { print("ИНВАРИАНТ: len =", len(${a}), "а элементов", ${n}) }`);
      push(`  if len(${a}) != ${a}.len() { print("ИНВАРИАНТ: len(xs) != xs.len()") }`);
    } else if (p === 2) {
      // push/pop возвращают длину на место.
      push(`  let ${a} = ${this.list(Math.min(d, 2))}.clone()`);
      push(`  let ${n} = len(${a})`);
      push(`  ${a}.push(${this.any(1)})`);
      push(`  if len(${a}) != ${n} + 1 { print("ИНВАРИАНТ: push не увеличил длину") }`);
      push(`  ${a}.pop()`);
      push(`  if len(${a}) != ${n} { print("ИНВАРИАНТ: pop не вернул длину") }`);
    } else if (p === 3) {
      // Отрицательный индекс совпадает с положительным.
      push(`  let ${a} = ${this.list(Math.min(d, 2))}`);
      push(`  if len(${a}) > 0 {`);
      push(`    if !(${a}[-1] == ${a}[len(${a}) - 1]) { print("ИНВАРИАНТ: xs[-1] != xs[len-1]") }`);
      push(`    if !(${a}[0] == ${a}[-len(${a})]) { print("ИНВАРИАНТ: xs[0] != xs[-len]") }`);
      push(`  }`);
    } else if (p === 4) {
      // sort ничего не теряет и не выдумывает.
      push(`  let ${a} = ${this.list(Math.min(d, 2))}`);
      push(`  let ${b} = ${a}.sort()`);
      push(`  if len(${a}) != len(${b}) { print("ИНВАРИАНТ: sort изменил длину", len(${a}), len(${b})) }`);
      push(`  for _e in ${a} { if !${b}.contains(_e) { print("ИНВАРИАНТ: sort потерял элемент", repr(_e)) } }`);
      push(`  for _e in ${b} { if !${a}.contains(_e) { print("ИНВАРИАНТ: sort выдумал элемент", repr(_e)) } }`);
    } else if (p === 5) {
      // Порядок ключей словаря устойчив, keys/values/entries согласованы.
      push(`  let ${a} = ${this.map(Math.min(d, 2))}`);
      push(`  if !(${a}.keys() == ${a}.keys()) { print("ИНВАРИАНТ: порядок ключей меняется") }`);
      push(`  if len(${a}.keys()) != len(${a}) { print("ИНВАРИАНТ: keys != len") }`);
      push(`  if len(${a}.values()) != len(${a}) { print("ИНВАРИАНТ: values != len") }`);
      push(`  if len(${a}.entries()) != len(${a}) { print("ИНВАРИАНТ: entries != len") }`);
    } else {
      // Равенство симметрично, клон равен оригиналу.
      push(`  let ${a} = ${this.list(Math.min(d, 2))}`);
      push(`  let ${b} = ${this.list(Math.min(d, 2))}`);
      push(`  if (${a} == ${b}) != (${b} == ${a}) { print("ИНВАРИАНТ: == несимметрично:", repr(${a}), repr(${b})) }`);
      push(`  if !(${a} == ${a}.clone()) { print("ИНВАРИАНТ: клон не равен оригиналу:", repr(${a})) }`);
    }
    push('} catch {')
    push('}');
  }

  /** Несколько инструкций подряд — тело блока. */
  body(indent: string, d: number, out: string[]): void {
    const n = d <= 0 ? 1 : 1 + this.r.int(2);
    for (let i = 0; i < n; i++) this.statement(indent, d - 1, out);
  }

  /**
   * «Поздняя привязка»: функция объявлена в блоке и зовёт имя, объявленное
   * ниже по файлу. Язык это разрешает — имя ищется в момент вызова.
   */
  lateBinding(out: string[]): void {
    const inner = this.name('вн');
    const later = this.name('поздняя');
    const holder = this.name('держатель');
    out.push(`let ${holder} = nil`);
    out.push(`{`);
    out.push(`  fn ${inner}() { return ${later}() }`);
    out.push(`  ${holder} = ${inner}`);
    out.push(`}`);
    this.late.push(later);
    this.vars.push({ name: holder, ty: 'any', mutable: true });
  }
}

/** Целая программа: структуры, функции, инструкции, отложенные объявления. */
export function generate(seed: number): string {
  const g = new Gen(new Rnd(seed));
  const out: string[] = [];

  for (const _ of g.r.times(0, 2)) g.structDecl(out);
  for (const _ of g.r.times(0, 2)) g.fnDecl('', 2, out);
  if (g.r.chance(0.15)) g.lateBinding(out);

  for (const _ of g.r.times(6, 14)) g.statement('', 3, out);

  for (const name of g.late) {
    out.push(`fn ${name}() { return 42 }`);
  }
  for (const name of g.late) {
    out.push(`print("поздняя привязка:", ${name}())`);
  }
  return out.join('\n') + '\n';
}

// ---- запуск ----------------------------------------------------------------

type RunResult = {
  code: number | null;
  signal: string | null;
  out: string;
  timedOut: boolean;
  /** Программа печатала так много, что её остановили: это то же зависание. */
  flood: boolean;
};

/** Сколько вывода готовы принять: дальше программа заведомо не остановится сама. */
const OUTPUT_LIMIT = 2_000_000;

/**
 * Живые потомки. Фаззер по делу запускает вечные циклы, и если оборвать его
 * самого (Ctrl+C), они останутся крутить процессор в фоне. Поэтому при выходе
 * мы гасим всё, что запустили.
 */
const alive = new Set<ReturnType<typeof spawn>>();
const killAll = (): void => {
  for (const child of alive) child.kill('SIGKILL');
  alive.clear();
};
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => { killAll(); process.exit(130); });
}

function run(args: string[], timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=256', CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    alive.add(child);
    let out = '';
    let seen = 0;
    let timedOut = false;
    let flood = false;
    const cap = (chunk: Buffer) => {
      seen += chunk.length;
      if (out.length < 200_000) out += chunk.toString('utf8');
      // Бесконечный поток вывода душит и потомка (очередь записи), и родителя.
      // Это тот же бесконечный цикл, только с печатью, — обрываем и зовём зависанием.
      if (seen > OUTPUT_LIMIT && !flood) {
        flood = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.on('error', () => {
      clearTimeout(timer);
      alive.delete(child);
      resolve({ code: null, signal: null, out: out + '\nНЕ УДАЛОСЬ ЗАПУСТИТЬ', timedOut, flood });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      alive.delete(child);
      resolve({ code, signal, out, timedOut, flood });
    });
  });
}

// ---- оракул ----------------------------------------------------------------

type Finding = {
  category: string;
  detail: string;
  source: string;
  seed: number;
  runOut: string;
  checkOut: string;
};

/** Следы внутренностей JS: пользователь такого видеть не должен никогда. */
export const JS_MARKERS = [
  'Maximum call stack', 'RangeError', 'TypeError', 'ReferenceError', 'SyntaxError',
  'at Parser.', 'at Interpreter.', 'at Lexer.', 'node:internal', 'heap out of memory',
  'ВНУТРЕННЯЯ ОШИБКА', 'Invalid string length',
];
/** Следы «дырявых» значений в выводе. */
export const VALUE_MARKERS = ['undefined', '[object Object]', 'NaN', '"unknown"', 'тип unknown'];
/** Сообщения, за которые отвечает статическая проверка. */
const CHECKER_OWNED = /не определено|уже объявлено|через const — менять нельзя|вне цикла|вне функции|ожидает .* аргумент/;

function classify(runRes: RunResult, checkRes: RunResult): { category: string; detail: string } | null {
  if (runRes.flood || checkRes.flood) {
    return { category: 'зависание', detail: 'бесконечный поток вывода — программа не останавливается' };
  }
  if (runRes.timedOut) return { category: 'зависание', detail: 'программа не уложилась в отведённое время' };
  if (checkRes.timedOut) return { category: 'зависание', detail: '--check не уложился в отведённое время' };

  for (const res of [runRes, checkRes]) {
    if (res.signal !== null) return { category: 'сбой', detail: `процесс убит сигналом ${res.signal}` };
    if (res.code !== null && ![0, 65, 70].includes(res.code)) {
      return { category: 'сбой', detail: `неожиданный код возврата ${res.code}` };
    }
  }

  const both = runRes.out + '\n' + checkRes.out;
  for (const mark of JS_MARKERS) {
    if (both.includes(mark)) return { category: 'js-внутренности', detail: `в выводе «${mark}»` };
  }
  for (const mark of VALUE_MARKERS) {
    if (both.includes(mark)) return { category: 'дырявое-значение', detail: `в выводе «${mark}»` };
  }

  const invariant = runRes.out.split('\n').find((l) => l.includes('ИНВАРИАНТ:'));
  if (invariant) return { category: 'инвариант', detail: invariant.trim() };

  // Генератор не должен порождать синтаксически неверный текст: если породил —
  // либо дефект генератора, либо парсер не принимает то, что сам же описал.
  if (runRes.code === 65) {
    return { category: 'синтаксис', detail: firstLine(runRes.out) };
  }

  const checkFailed = checkRes.code === 65;
  if (checkFailed && runRes.code === 0) {
    return { category: 'ложная-тревога', detail: firstError(checkRes.out) };
  }
  if (!checkFailed && runRes.code === 70 && CHECKER_OWNED.test(runRes.out)) {
    return { category: 'пропуск-анализатора', detail: firstLine(runRes.out) };
  }
  return null;
}

const firstLine = (text: string): string => text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

const firstError = (text: string): string =>
  text.split('\n').find((l) => l.startsWith('Ошибка:'))?.trim() ?? firstLine(text);

/** Подпись сбоя: по ней сокращатель понимает, что урезанный пример падает так же. */
const signature = (v: { category: string; detail: string }): string =>
  `${v.category}|${v.detail.replace(/\d+/g, '#').replace(/«[^»]*»/g, '«»').slice(0, 120)}`;

// ---- сокращение примера ----------------------------------------------------

/**
 * Границы сбалансированных кусков: строка со своим блоком целиком.
 * Скобки внутри строковых литералов пропускаются — иначе `"${x}"` собьёт счёт.
 */
function depthDelta(line: string): number {
  let delta = 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '{' || c === '(' || c === '[') delta++;
    if (c === '}' || c === ')' || c === ']') delta--;
  }
  return delta;
}

/** Куски-кандидаты на удаление: одиночная строка либо строка вместе со своим блоком. */
function units(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    let depth = depthDelta(lines[i]!);
    if (depth <= 0) { out.push([i, i]); continue; }
    let j = i;
    while (depth > 0 && j + 1 < lines.length) {
      j++;
      depth += depthDelta(lines[j]!);
    }
    if (depth === 0) out.push([i, j]);
  }
  // Снизу вверх: удаление куска не сдвигает номера строк выше него,
  // поэтому за один проход можно выкинуть сразу много кусков.
  return out.reverse();
}

type Judge = (source: string) => Promise<string | null>;

/**
 * Имена, объявленные в куске текста. Нужны сокращателю: выкинув объявление,
 * но оставив обращения к имени, мы получили бы «имя не определено» — не тот
 * дефект, который искали, а свежесломанную программу.
 */
function declaredIn(text: string): string[] {
  const out: string[] = [];
  const re = /(?:let|const|fn|struct)\s+([A-Za-z_À-ɏЀ-ӿ][\wÀ-ɏЀ-ӿʻʼ‘’]*)|for\s+([A-Za-z_À-ɏЀ-ӿ][\wÀ-ɏЀ-ӿʻʼ‘’]*)\s+in\b/g;
  for (const m of text.matchAll(re)) out.push((m[1] ?? m[2])!);
  return out;
}

/**
 * Все ли `while` в тексте остались ограниченными: в теле каждого есть
 * присваивание переменной из условия. Без этой проверки сокращение зависания
 * вырождается в «выкинуть счётчик» — цикл станет вечным, и урезанный пример
 * будет показывать не найденный дефект, а свежесломанный цикл.
 */
function loopsStayBounded(lines: string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*while\s+(.*)\{\s*$/.exec(lines[i]!);
    if (!head) continue;
    const names = head[1]!.match(/[A-Za-z_À-ɏЀ-ӿ][\wÀ-ɏЀ-ӿʻʼ‘’]*/g) ?? [];
    let depth = 1;
    let touched = false;
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      depth += depthDelta(lines[j]!);
      if (names.some((n) => new RegExp(`(?<![\\w])${n}\\s*(=[^=]|\\+=|-=|\\*=|/=)`).test(lines[j]!))) touched = true;
    }
    if (!touched) return false;
  }
  return true;
}

/** Жадное урезание: выкидываем куски, пока пример продолжает падать так же. */
async function shrink(source: string, want: string, judge: Judge, budget: number): Promise<string> {
  let lines = source.split('\n').filter((l) => l !== '');
  let spent = 0;
  let changed = true;
  while (changed && spent < budget) {
    changed = false;
    // Куски считаются один раз на проход и перебираются снизу вверх:
    // успешное удаление не ломает границы кусков, лежащих выше.
    for (const [from, to] of units(lines)) {
      if (spent >= budget) break;
      if (to >= lines.length) continue;
      // Вариант 1 — выкинуть кусок целиком; вариант 2 — снять обёртку
      // (try/if/for/while), оставив содержимое: вложенность почти никогда не
      // участвует в сбое, а читать четыре уровня отступа невозможно.
      const candidates: Array<{ kept: string[]; dropped: string }> = [
        { kept: [...lines.slice(0, from), ...lines.slice(to + 1)], dropped: lines.slice(from, to + 1).join('\n') },
      ];
      if (to > from + 1) {
        const body = lines.slice(from + 1, to);
        const inner = body.filter((l) => !l.trim().startsWith('}')).map((l) => (l.startsWith('  ') ? l.slice(2) : l));
        if (inner.length) {
          candidates.push({
            kept: [...lines.slice(0, from), ...inner, ...lines.slice(to + 1)],
            dropped: [lines[from]!, ...body.filter((l) => l.trim().startsWith('}')), lines[to]!].join('\n'),
          });
        }
      }

      for (const { kept, dropped } of candidates) {
        if (spent >= budget) break;
        if (kept.length >= lines.length || kept.length === 0) continue;
        const rest = kept.join('\n');
        // Осиротевшая ссылка на удалённое имя — не сокращение, а другая программа.
        if (declaredIn(dropped).some((n) => new RegExp(`(?<![\\w])${n}(?![\\w])`).test(rest))) continue;
        if (!loopsStayBounded(kept)) continue;
        spent++;
        if ((await judge(rest + '\n')) === want) {
          lines = kept;
          changed = true;
          break;
        }
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ---- главный цикл ----------------------------------------------------------

const TMP = mkdtempSync(join(tmpdir(), 'sable-fuzz-'));
let tmpCounter = 0;

type Verdict = { sig: string | null; runOut: string; checkOut: string };

const CLEAN: RunResult = { code: 0, signal: null, out: '', timedOut: false, flood: false };
/** Сокращение перебирает похожие тексты — за один и тот же дважды платить не надо. */
const judged = new Map<string, Verdict>();

async function judgeSource(source: string, timeout = TIMEOUT): Promise<Verdict> {
  const key = `${timeout}|${source}`;
  const hit = judged.get(key);
  if (hit) return hit;

  const file = join(TMP, `f${tmpCounter++ % 64}.sable`);
  writeFileSync(file, source, 'utf8');
  const runRes = await run([file], timeout);
  // Предварительный вердикт по одному прогону: если он уже что-то нашёл и это
  // не расхождение с анализатором, второй запуск не нужен.
  const quick = classify(runRes, CLEAN);
  const needCheck = quick === null || quick.category === 'пропуск-анализатора';
  const checkRes = needCheck && !runRes.timedOut ? await run(['--check', file], timeout) : CLEAN;
  const verdict = classify(runRes, checkRes);

  const out: Verdict = {
    sig: verdict ? signature(verdict) : null,
    runOut: runRes.out,
    checkOut: checkRes.out,
  };
  if (judged.size < 4000) judged.set(key, out);
  return out;
}

async function main(): Promise<number> {
  if (ONLY !== null) {
    process.stdout.write(generate(ONLY));
    return 0;
  }

  process.stdout.write(
    `sable fuzz — зерно ${SEED}, программ ${COUNT}, таймаут ${TIMEOUT} мс, потоков ${JOBS}\n\n`,
  );

  const seeds = Array.from({ length: COUNT }, (_, i) => (SEED + i * 2654435761) >>> 0);
  const found = new Map<string, Finding>();
  const counts = new Map<string, number>();
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const seed = seeds.pop();
      if (seed === undefined) return;
      const source = generate(seed);
      const { sig, runOut, checkOut } = await judgeSource(source);
      done++;
      if (done % 25 === 0) process.stdout.write(`  прогнано ${done}/${COUNT}\n`);
      if (sig === null) continue;
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
      if (found.has(sig)) continue;
      const [category, ...rest] = sig.split('|');
      found.set(sig, {
        category: category!,
        detail: rest.join('|'),
        source,
        seed,
        runOut,
        checkOut,
      });
      process.stdout.write(`  ! ${category}: ${rest.join('|')} (зерно ${seed})\n`);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, JOBS) }, () => worker()));

  process.stdout.write(`\nПрогнано ${COUNT} программ. Разных сбоев: ${found.size}\n`);
  if (found.size === 0) {
    process.stdout.write('Дефектов не найдено.\n');
    rmSync(TMP, { recursive: true, force: true });
    return 0;
  }

  mkdirSync(FINDINGS, { recursive: true });
  let index = 0;
  for (const [sig, finding] of found) {
    index++;
    process.stdout.write(`\n[${index}] ${finding.category}: ${finding.detail}\n`);
    process.stdout.write(`    встретилось раз: ${counts.get(sig)}, зерно ${finding.seed}\n`);
    process.stdout.write(`    сокращаю пример (${finding.source.split('\n').length} строк)...\n`);

    // Сокращаем на укороченном таймауте: иначе каждый шаг для зависания стоит
    // полного ожидания, и сокращение одного примера растянется на часы.
    const quick = Math.max(1200, Math.round(TIMEOUT / 3));
    const judge: Judge = async (src) => (await judgeSource(src, quick)).sig;
    let small = await shrink(finding.source, sig, judge, SHRINK_BUDGET);
    let after = await judgeSource(small);
    // Страховка: если на полном таймауте урезанное больше не воспроизводится,
    // отчёт должен показать исходную программу, а не красивую, но чужую.
    if (after.sig !== sig) {
      small = finding.source;
      after = await judgeSource(small);
      process.stdout.write('    сокращение не подтвердилось — сохраняю исходную программу\n');
    }

    // Префикс «fuzz_» отделяет свежий улов от разобранных вручную примеров,
    // которые лежат в той же папке под своими именами.
    const name = `fuzz_${String(index).padStart(2, '0')}_${finding.category}.sable`;
    const header = [
      `// Найдено фаззером: node tests/fuzz.ts --seed=${finding.seed}`,
      `// Класс: ${finding.category}`,
      `// Признак: ${finding.detail}`,
      '// Ожидалось: результат или ошибка sable со стрелкой; получено — см. ниже.',
      '// Фактический вывод:',
      ...after.runOut.split('\n').slice(0, 12).map((l) => `//   ${l}`),
      '',
    ].join('\n');
    writeFileSync(join(FINDINGS, name), header + small, 'utf8');
    process.stdout.write(`    сокращено до ${small.split('\n').length - 1} строк → tests/fuzz-findings/${name}\n`);
    process.stdout.write(small.split('\n').map((l) => `      ${l}`).join('\n') + '\n');
  }

  rmSync(TMP, { recursive: true, force: true });
  return 1;
}

// Файл служит и самостоятельным охотником, и складом деталей для tests/fuzz-tools.ts.
// Поэтому главный цикл запускается только при прямом вызове, а не при импорте.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
