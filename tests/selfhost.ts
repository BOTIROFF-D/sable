// Самоприменение: лексер Sable, написанный на Sable, обязан выдавать тот же
// поток лексем, что и настоящий лексер на TypeScript.
//
// Сверка идёт не на паре показательных примеров, а на каждом файле `.sable`
// в репозитории — включая сам selfhost/lexer.sable, то есть язык разбирает
// собственный исходник. Расхождение хоть в одной лексеме валит набор.
//
// Отдельно проверяются записи, которых в обычном коде почти не встретишь:
// вложенные комментарии, строка со вставкой внутри строки, «1..5» против
// «1.5», «1e» без показателя. Именно на них ломаются лексеры, а до репозитория
// такие случаи могут и не дойти.
//
// Запуск: node tests/selfhost.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../src/lexer.ts';
import type { Token } from '../src/token.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const DRIVER = join(ROOT, 'selfhost', 'main.sable');

const problems: string[] = [];
const ok = (what: string) => process.stdout.write(`  ✓ ${what}\n`);
const fail = (what: string, why: string) => {
  process.stdout.write(`  ✗ ${what}\n`);
  problems.push(`${what}: ${why}`);
};

/** Не заходим в служебные и собранные каталоги: там чужие файлы. */
/** Что печатает перёд на Sable вместо потока, когда разбор не удался. */
const REFUSED = '!!! отказ';

const SKIP = new Set(['node_modules', '.git', 'dist', '.github']);

function sableFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sableFiles(path, found);
    else if (entry.endsWith('.sable')) found.push(path);
  }
  return found;
}

/**
 * Каноническая запись потока. Позиции сюда не входят намеренно: настоящий
 * лексер считает колонки в единицах UTF-16, а Sable — в символах, и на эмодзи
 * они расходятся законно. Всё остальное обязано совпадать посимвольно.
 */
function canon(tokens: Token[]): string {
  return tokens.map((t) => {
    if (t.type === 'NUMBER') return `NUMBER ${String(t.value)}`;
    if (t.type === 'IDENT') return `IDENT ${t.lexeme}`;
    // У строки со вставками готового значения нет — сверяем по числу вставок.
    if (t.type === 'STRING') {
      return t.parts === undefined
        ? `STRING ${String(t.value)}`
        : `STRING @${t.parts.filter((p) => p.kind === 'expr').length}`;
    }
    return t.type;
  }).join('\n');
}

/**
 * Прогоняет самодельный лексер по списку файлов за один запуск. Один процесс на
 * весь список, а не на файл: разбор самого лексера занимает больше, чем разбор
 * иного файла из списка.
 */
function selfhost(paths: string[]): Map<string, string> {
  const sent = paths.map((p) => relative(ROOT, p));
  const r = spawnSync(process.execPath, [CLI, DRIVER], {
    cwd: ROOT,
    input: sent.join('\n') + '\n',
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`перёд на Sable завершился с кодом ${r.status}:\n${r.stderr}`);
  }

  const byName = new Map<string, string>();
  let file = '';
  let lines: string[] = [];
  // Последний перевод строки вывода даёт пустой хвост — в потоке лексем пустых
  // строк не бывает, так что он всегда лишний.
  const done = () => {
    if (lines[lines.length - 1] === '') lines.pop();
    byName.set(file, lines.join('\n'));
  };
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('=== ')) {
      if (file) done();
      file = line.slice(4);
      lines = [];
    } else {
      lines.push(line);
    }
  }
  if (file) done();

  // Обратно к тем путям, которые дал вызывающий: временные файлы лежат вне
  // репозитория, и по ним искать удобнее по исходному пути.
  const streams = new Map<string, string>();
  paths.forEach((p, i) => {
    const stream = byName.get(sent[i]!);
    if (stream !== undefined) streams.set(p, stream);
  });
  return streams;
}

// ---- каждый файл репозитория ----------------------------------------------

const files = sableFiles(ROOT);
if (files.length < 30) fail('поиск файлов', `нашлось всего ${files.length} — похоже, обход сломан`);

let streams: Map<string, string>;
try {
  streams = selfhost(files);
} catch (e) {
  fail('запуск переда на Sable', (e as Error).message);
  process.stdout.write(`\nсамоприменение: ${problems[0]}\n`);
  process.exitCode = 1;
  throw new Error('перёд на Sable не запустился');
}

let matched = 0;
for (const path of files) {
  const name = relative(ROOT, path);
  const source = readFileSync(path, 'utf8');

  // Файл с намеренно битым синтаксисом — тоже результат: оба лексера обязаны
  // отказаться, и отказаться одновременно.
  let expected: string;
  try {
    expected = canon(tokenize(source, name));
  } catch {
    expected = REFUSED;
  }

  const got = streams.get(path);
  if (got === undefined) { fail(name, 'перёд на Sable ничего не выдал'); continue; }
  if (got === expected) { matched++; continue; }
  if (expected === REFUSED) { fail(name, 'настоящий лексер отказался, перёд на Sable разобрал'); continue; }
  if (got === REFUSED) { fail(name, 'перёд на Sable отказался, настоящий лексер разобрал'); continue; }

  const a = expected.split('\n');
  const b = got.split('\n');
  const i = a.findIndex((line, n) => line !== b[n]);
  fail(name, `лексема ${i + 1}: настоящий лексер даёт «${a[i]}», перёд на Sable — «${b[i] ?? '(конца нет)'}»`);
}
if (problems.length === 0) ok(`${matched} файлов репозитория разобраны одинаково`);

// ---- записи, которых в репозитории может и не быть -------------------------

const TRICKY: Array<[string, string]> = [
  ['вложенный комментарий', 'let a = 1 /* внешний /* внутренний */ ещё внешний */ + 2\n'],
  ['строка во вставке', 'print("итог: ${ m.get("ключ") } готово")\n'],
  ['фигурная скобка во вставке', 'print("${ { "a": 1 }.len() }")\n'],
  ['диапазон против дробного', 'for i in 1..5 { print(1.5) }\n'],
  ['показатель без цифр', 'let e = 1\nprint(1 + e)\n'],
  ['показатель со знаком', 'print(1e-7, 2E+3, 1e3)\n'],
  ['перенос внутри скобок', 'print(\n  1,\n  2,\n)\n'],
  ['перенос внутри тела в аргументе', 'run(fn () {\n  let a = 1\n  print(a)\n})\n'],
  ['окина в имени', 'let oʻquvchi = 1\nprint(oʻquvchi)\n'],
  ['коды символов', 'print("\\u{41}\\u{0416}\\u{1F600}")\n'],
  ['экраны', 'print("а\\nб\\tв\\\\г\\"д\\$е")\n'],
  ['обратные кавычки', 'print(`первая\nвторая`)\n'],
  ['подчёркивания и шестнадцатеричное', 'print(1_000_000, 0xFF, 0x_1F)\n'],
  ['словесные операторы', 'print(true and false or not true)\n'],
  ['слипшиеся знаки', 'a??b\nc?d:e\nx..y\nf->g\n'],
  ['пустой файл', ''],
  ['только комментарий', '// ничего\n'],
];

const BOX = mkdtempSync(join(tmpdir(), 'sable-selfhost-'));
const trickyPaths = TRICKY.map(([name, src], i) => {
  const path = join(BOX, `case${i}.sable`);
  writeFileSync(path, src, 'utf8');
  return { name, src, path };
});

try {
  const got = selfhost(trickyPaths.map((c) => c.path));
  for (const c of trickyPaths) {
    const expected = canon(tokenize(c.src, c.name));
    const actual = got.get(c.path);
    if (actual === REFUSED) { fail(c.name, 'перёд на Sable отказался разбирать'); continue; }
    if (actual === expected) { ok(c.name); continue; }
    const a = expected.split('\n');
    const b = (actual ?? '').split('\n');
    const i = a.findIndex((line, n) => line !== b[n]);
    fail(c.name, `лексема ${i + 1}: ожидалось «${a[i]}», получено «${b[i] ?? '(конца нет)'}»`);
  }
} catch (e) {
  fail('трудные записи', (e as Error).message);
} finally {
  rmSync(BOX, { recursive: true, force: true });
}

const total = TRICKY.length + 1;
process.stdout.write(
  problems.length === 0
    ? `\nсамоприменение: ${total}/${total} прошло (${matched} файлов сверено)\n`
    : `\nсамоприменение: расхождений ${problems.length}\n\n${problems.join('\n')}\n`,
);
if (problems.length > 0) process.exitCode = 1;
