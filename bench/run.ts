// Стенд замеров скорости интерпретатора dbgo.
//
//   node bench/run.ts                — прогнать всё и сравнить с bench/baseline.json
//   node bench/run.ts --save         — прогнать и записать результат как новый базовый замер
//   node bench/run.ts --only=fib     — только замеры, чьё имя содержит «fib»
//   node bench/run.ts --runs=7       — сколько раз повторить каждый замер (по умолчанию 5)
//
// Каждая программа bench/*.dbgo объявляет в шапке число логических операций
// строкой «// ops: N» — из него считаются операции в секунду. Число условно
// (что считать операцией — вопрос вкуса), но оно постоянно, поэтому сравнение
// «было → стало» по нему честное.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbgoError, formatError, forgetSources, registerSource } from '../src/errors.ts';
import { Interpreter } from '../src/interpreter.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, 'baseline.json');

const args = process.argv.slice(2);
const save = args.includes('--save');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const runs = Number(args.find((a) => a.startsWith('--runs='))?.slice('--runs='.length)) || 5;

type Result = { name: string; best: number; ops: number; opsPerSec: number };
type Baseline = { node: string; date: string; results: Record<string, { best: number; ops: number }> };

/** Число операций из шапки файла: «// ops: 1000000». */
function opsOf(source: string): number {
  const m = /^\s*\/\/\s*ops:\s*(\d+)/m.exec(source);
  return m ? Number(m[1]) : 1;
}

/**
 * Один прогон программы. Вывод перехватывается: печать в терминал заняла бы
 * заметную долю времени и мерился бы не интерпретатор, а stdout.
 */
function once(program: ReturnType<typeof parse>, fullPath: string): number {
  const interp = new Interpreter({ write: () => {} }, fullPath);
  const t0 = performance.now();
  interp.run(program);
  return performance.now() - t0;
}

function measure(file: string): Result {
  const fullPath = join(HERE, file);
  const source = readFileSync(fullPath, 'utf8');
  const name = file.replace(/\.dbgo$/, '');
  forgetSources();
  registerSource(file, source);
  // Разбор вне измерения: меряем интерпретатор, а не лексер с парсером.
  const program = parse(tokenize(source, file), file);

  once(program, fullPath); // прогрев: первый прогон платит за JIT

  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, once(program, fullPath));

  const ops = opsOf(source);
  return { name, best, ops, opsPerSec: (ops / best) * 1000 };
}

// ---- печать таблицы -------------------------------------------------------

const num = (n: number, digits = 1): string =>
  n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Операции в секунду в удобочитаемом виде: 12,3 млн/с. */
function human(ops: number): string {
  if (ops >= 1e6) return `${num(ops / 1e6)} млн/с`;
  if (ops >= 1e3) return `${num(ops / 1e3)} тыс/с`;
  return `${num(ops)} /с`;
}

/** Насколько стало быстрее: положительный процент — ускорение. */
function delta(oldMs: number, newMs: number): string {
  const pct = ((oldMs - newMs) / oldMs) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${num(pct)}%`;
}

function pad(s: string, w: number): string { return s + ' '.repeat(Math.max(0, w - width(s))); }
function padLeft(s: string, w: number): string { return ' '.repeat(Math.max(0, w - width(s))) + s; }
/** Длина в символах, а не в кодовых единицах — в именах бывает кириллица. */
function width(s: string): number { return [...s].length; }

function report(results: Result[], base: Baseline | null): void {
  const cols = base
    ? ['замер', 'было, мс', 'стало, мс', 'разница', 'операций/с']
    : ['замер', 'лучшее, мс', 'операций/с'];

  const rows = results.map((r) => {
    const prev = base?.results[r.name];
    if (!base) return [r.name, num(r.best, 2), human(r.opsPerSec)];
    if (!prev) return [r.name, '—', num(r.best, 2), 'новый', human(r.opsPerSec)];
    // Если число операций в программе поменяли, сравнивать миллисекунды нечестно.
    const comparable = prev.ops === r.ops;
    return [
      r.name,
      num(prev.best, 2),
      num(r.best, 2),
      comparable ? delta(prev.best, r.best) : 'ops изменён',
      human(r.opsPerSec),
    ];
  });

  const w = cols.map((c, i) => Math.max(width(c), ...rows.map((row) => width(row[i]!))));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? pad(c, w[i]!) : padLeft(c, w[i]!))).join('  ');

  process.stdout.write(line(cols) + '\n');
  process.stdout.write(w.map((n) => '─'.repeat(n)).join('  ') + '\n');
  for (const row of rows) process.stdout.write(line(row) + '\n');

  if (base) {
    const comparable = results.filter((r) => base.results[r.name]?.ops === r.ops);
    if (comparable.length) {
      const oldSum = comparable.reduce((s, r) => s + base.results[r.name]!.best, 0);
      const newSum = comparable.reduce((s, r) => s + r.best, 0);
      process.stdout.write(
        `\nсуммарно по ${comparable.length} замерам: ${num(oldSum, 2)} → ${num(newSum, 2)} мс (${delta(oldSum, newSum)})\n`,
      );
    }
    process.stdout.write(`базовый замер: ${base.date}, Node ${base.node}\n`);
  }
}

// ---- запас стека ----------------------------------------------------------

/**
 * Проверка, которую не делают golden-тесты, а стоило бы: хватает ли стека JS
 * на объявленный предел рекурсии. Собственный предел (900 вызовов) должен
 * срабатывать раньше срыва стека Node — иначе вместо понятного сообщения
 * пользователь получит «слишком глубокая вложенность вычислений».
 *
 * Ловушка здесь тонкая: любая правка интерпретатора, добавившая переменных в
 * `evaluate` или `execute`, раздувает кадр JS и незаметно съедает этот запас.
 */
function checkStackMargin(): boolean {
  const source = 'fn d(n) { return d(n + 1) }\nd(0)\n';
  const file = '<запас стека>';
  forgetSources();
  registerSource(file, source);
  let message = '';
  try {
    new Interpreter({ write: () => {} }, file).run(parse(tokenize(source, file), file));
  } catch (e) {
    message = e instanceof DbgoError ? e.message : String(e);
  }
  const ok = message.startsWith('слишком глубокая рекурсия');
  process.stdout.write(
    ok
      ? '\nзапас стека: свой предел рекурсии срабатывает раньше стека Node — порядок\n'
      : `\nЗАПАС СТЕКА ИСЧЕРПАН: вместо своего предела получено «${message}».\n` +
        'Кадр evaluate/execute вырос — вынесите редкие ветки switch в отдельные методы.\n',
  );
  return ok;
}

// ---- запуск ---------------------------------------------------------------

const files = readdirSync(HERE)
  .filter((f) => f.endsWith('.dbgo'))
  .sort()
  .filter((f) => !only || f.includes(only));

if (files.length === 0) {
  process.stdout.write('нечего мерить: bench/*.dbgo не найдены\n');
  process.exit(1);
}

const base: Baseline | null = !save && existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline
  : null;

const results: Result[] = [];
for (const file of files) {
  process.stderr.write(pad(`  … ${file}`, 40) + '\r');
  try {
    results.push(measure(file));
  } catch (e) {
    process.stderr.write(`\n${file}: замер не выполнился\n`);
    if (e instanceof DbgoError) process.stderr.write(formatError(e, readFileSync(join(HERE, file), 'utf8')) + '\n');
    else throw e;
    process.exitCode = 1;
  }
}
process.stderr.write(' '.repeat(40) + '\r');

report(results, base);

if (!checkStackMargin()) process.exitCode = 1;

if (save) {
  const out: Baseline = {
    node: process.version,
    date: new Date().toISOString().slice(0, 19).replace('T', ' '),
    results: Object.fromEntries(results.map((r) => [r.name, { best: r.best, ops: r.ops }])),
  };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.stdout.write(`\nбазовый замер записан: ${BASELINE}\n`);
}
