// Самоприменение, третий этаж: интерпретатор Sable, написанный на Sable,
// обязан выполнять программы так же, как настоящий.
//
// Сверяется не «примерно то же», а напечатанное — до буквы. Берутся настоящие
// программы репозитория: все примеры из `examples/` и все golden-случаи из
// `tests/cases/`. Каждая выполняется дважды и сравнивается.
//
// Программа, которая падает, — тоже результат: упасть обязаны обе, на одном и
// том же месте вывода. Текст ошибки сверяется отдельным, более мягким
// требованием: у переда на Sable нет позиций в дереве, поэтому строку и
// колонку он назвать не может — сверяется только само сообщение.
//
// Запуск: node tests/selfrun.ts
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SableError } from '../src/errors.ts';
import { Interpreter } from '../src/interpreter.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const DRIVER = join(ROOT, 'selfhost', 'запуск.sable');

const problems: string[] = [];
const ok = (what: string) => process.stdout.write(`  ✓ ${what}\n`);
const fail = (what: string, why: string) => {
  process.stdout.write(`  ✗ ${what}\n`);
  problems.push(`${what}: ${why}`);
};

/**
 * Чего перед на Sable не повторяет — с причиной на каждый случай. Молчаливое
 * сокращение покрытия читается как «сверено всё», поэтому список печатается.
 */
const SKIP: Array<[string, string]> = [
  ['tests/cases/33_err_recursion.sable', 'упирается в предел вложенности вызовов, а у переда на Sable он свой'],
  ['tests/cases/54_err_deep_nesting.sable', 'то же про предел вложенности выражений'],
  ['tests/cases/71_cycles.sable', 'печать значения, ссылающегося на себя: у нас нет сравнения по ссылке'],
];

const skipped = new Map(SKIP);

/** Недетерминированное сверять нечем: у двух запусков разный ответ по замыслу. */
const RANDOM = /\b(random|random_int|now|clock)\s*\(/;

type Expected = { out: string; failed: boolean; message: string };

/** Настоящий интерпретатор, с перехваченным выводом — как в golden-тестах. */
function real(source: string, file: string, full: string): Expected {
  let out = '';
  const interp = new Interpreter({ write: (t) => { out += t; }, args: [] }, full);
  try {
    interp.run(parse(tokenize(source, file), file));
    return { out, failed: false, message: '' };
  } catch (e) {
    if (e instanceof SableError) return { out, failed: true, message: e.message };
    return { out, failed: true, message: `внутренняя ошибка: ${(e as Error).message}` };
  }
}

/**
 * Перёд на Sable: все программы за один запуск. Границы размечены управляющими
 * символами, а не строками: вывод программы может кончиться без перевода строки
 * или содержать что угодно, и по строкам его потом не разрезать без догадок.
 */
type Got = { out: string; failed: boolean; message: string };

function selfhost(paths: string[]): Map<string, Got> {
  const sent = paths.map((p) => relative(ROOT, p));
  const r = spawnSync(process.execPath, [CLI, DRIVER, ...sent], {
    cwd: ROOT,
    input: '',
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`перёд на Sable завершился с кодом ${r.status}:\n${r.stderr.slice(0, 2000)}`);
  }

  const byName = new Map<string, Got>();
  for (const chunk of r.stdout.split('\u0001').slice(1)) {
    const at = chunk.indexOf('\u0002');
    const name = chunk.slice(0, at);
    const body = chunk.slice(at + 1);
    const bad = body.indexOf('\u0003');
    byName.set(name, bad < 0
      ? { out: body, failed: false, message: '' }
      : { out: body.slice(0, bad), failed: true, message: body.slice(bad + 1) });
  }

  const streams = new Map<string, Got>();
  paths.forEach((p, i) => {
    const got = byName.get(sent[i]!);
    if (got !== undefined) streams.set(p, got);
  });
  return streams;
}

/** Первое расхождение: номер строки указывает место точнее любого пересказа. */
function firstDiff(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const i = a.findIndex((line, n) => line !== b[n]);
  const at = i < 0 ? Math.min(a.length, b.length) : i;
  return `строка ${at + 1}: настоящий печатает ${JSON.stringify(a[at] ?? null)},`
    + ` перёд на Sable — ${JSON.stringify(b[at] ?? null)}`;
}

// ---- что берём -------------------------------------------------------------

function programs(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.sable')).sort().map((f) => join(dir, f));
}

const all = [...programs(join(ROOT, 'examples')), ...programs(join(ROOT, 'tests', 'cases'))];

const chosen: string[] = [];
for (const path of all) {
  const name = relative(ROOT, path);
  if (skipped.has(name)) continue;
  if (RANDOM.test(readFileSync(path, 'utf8'))) {
    skipped.set(name, 'зовёт random/now/clock — два запуска отвечают разное по замыслу');
    continue;
  }
  chosen.push(path);
}

let streams: Map<string, Got>;
try {
  streams = selfhost(chosen);
} catch (e) {
  fail('запуск переда на Sable', (e as Error).message);
  process.stdout.write(`\nсамовыполнение: ${problems[0]}\n`);
  process.exitCode = 1;
  throw new Error('перёд на Sable не запустился');
}

let same = 0;
let broke = 0;
for (const path of chosen) {
  const name = relative(ROOT, path);
  const source = readFileSync(path, 'utf8');

  let expected: Expected;
  try {
    expected = real(source, name, path);
  } catch {
    // Программа не разбирается настоящим парсером — про выполнение речи нет.
    skipped.set(name, 'не разбирается: проверяется другим набором');
    continue;
  }

  const got = streams.get(path);
  if (got === undefined) { fail(name, 'перёд на Sable ничего не выдал'); continue; }

  if (expected.failed !== got.failed) {
    fail(name, expected.failed
      ? `настоящий упал на «${expected.message}», перёд на Sable выполнил до конца`
      : `перёд на Sable упал на «${got.message}», настоящий выполнил до конца`);
    continue;
  }
  if (expected.out !== got.out) { fail(name, firstDiff(expected.out, got.out)); continue; }
  if (expected.failed && expected.message !== got.message) {
    fail(name, `сообщение: настоящий — «${expected.message}», перёд на Sable — «${got.message}»`);
    continue;
  }
  if (expected.failed) broke++;
  same++;
}

if (problems.length === 0) {
  ok(`${same} программ выполнены одинаково, из них ${broke} упали на одном и том же`);
}

// Совпавшее падение — тоже совпадение, поэтому перёд, который падает всегда,
// прошёл бы сверку целиком. Требуем, чтобы выполненных было большинство.
if (same - broke < chosen.length / 2) {
  fail('слишком много падений', `выполнено до конца ${same - broke} из ${chosen.length}`);
}

process.stdout.write(`\n  пропущено ${skipped.size}:\n`);
for (const [name, why] of [...skipped].sort()) process.stdout.write(`    ${name} — ${why}\n`);

process.stdout.write(
  problems.length === 0
    ? `\nсамовыполнение: ${same}/${chosen.length} совпало\n`
    : `\nсамовыполнение: расхождений ${problems.length}\n\n${problems.join('\n')}\n`,
);
if (problems.length > 0) process.exitCode = 1;
