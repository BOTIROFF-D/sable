// Самоприменение: лексер и парсер Sable, написанные на Sable, обязаны выдавать
// то же, что настоящие — лексема в лексему и узел в узел.
//
// Сверка идёт не на паре показательных примеров, а на каждом файле `.sable`
// в репозитории — включая исходники самих лексера и парсера, то есть язык
// разбирает собственный перёд. Расхождение хоть в одном узле валит набор.
//
// Файл с намеренно битым синтаксисом — тоже результат: отказаться обязаны оба
// и одновременно. Сверх репозитория проверяются записи, которых в нём может и
// не быть: вложенные комментарии, строка внутри вставки, «1..5» против «1.5»,
// приоритет степени и унарного минуса. Именно на них ломаются разборщики,
// а до репозитория такие случаи могут и не дойти.
//
// Запуск: node tests/selfhost.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import type { Token } from '../src/token.ts';
import { reprProgram } from './ast-repr.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.ts');

/** Что печатает перёд на Sable вместо результата, когда разбор не удался. */
const REFUSED = '!!! отказ';

const problems: string[] = [];
const ok = (what: string) => process.stdout.write(`  ✓ ${what}\n`);
const fail = (what: string, why: string) => {
  process.stdout.write(`  ✗ ${what}\n`);
  problems.push(`${what}: ${why}`);
};

/** Не заходим в служебные и собранные каталоги: там чужие файлы. */
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
 * Каноническая запись потока лексем. Позиции сюда не входят намеренно:
 * настоящий лексер считает колонки в единицах UTF-16, а Sable — в символах,
 * и на эмодзи они расходятся законно. Всё остальное обязано совпадать.
 */
function canonTokens(tokens: Token[]): string {
  return tokens.map((t) => {
    if (t.type === 'NUMBER') return `NUMBER ${String(t.value)}`;
    if (t.type === 'IDENT') return `IDENT ${t.lexeme}`;
    // У строки со вставками готового значения нет — сверяем по числу вставок.
    if (t.type === 'STRING') {
      return t.parts === undefined
        ? `STRING ${String(t.value)}`
        : `STRING @${t.parts.filter((p) => p.kind === 'expr').length}`;
    }
    // Для остальных сверяется и сама запись: «=» вместо «==» не меняет вида
    // лексемы, но меняет смысл выражения — парсер берёт оператор отсюда.
    if (t.type === 'NEWLINE' || t.type === 'EOF') return t.type;
    return `${t.type} ${t.lexeme}`;
  }).join('\n');
}

/**
 * Прогоняет перёд на Sable по списку файлов за один запуск. Один процесс на
 * весь список, а не на файл: разбор самого парсера занимает больше, чем разбор
 * иного файла из списка.
 */
function selfhost(driver: string, paths: string[]): Map<string, string> {
  const sent = paths.map((p) => relative(ROOT, p));
  const r = spawnSync(process.execPath, [CLI, join(ROOT, 'selfhost', driver), ...sent], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`перёд на Sable завершился с кодом ${r.status}:\n${r.stderr}`);
  }

  const byName = new Map<string, string>();
  let file = '';
  let lines: string[] = [];
  // Последний перевод строки вывода даёт пустой хвост — в записи результата
  // пустых строк не бывает, так что он всегда лишний.
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

type Stage = {
  /** Как называется то, что сверяется, — для сообщений. */
  name: string;
  /** Программа на Sable, печатающая результат для каждого файла из аргументов. */
  driver: string;
  /** Настоящий перёд. Бросает — значит отказывается разбирать. */
  real: (source: string, file: string) => string;
  /** Единица расхождения: «лексема 12» или «узел 12». */
  unit: string;
  /** Записи, которых в репозитории может и не быть. */
  tricky: Array<[string, string]>;
};

/** Первое расхождение: читать целиком незачем, а номер строки указывает место. */
function firstDiff(expected: string, actual: string, unit: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const i = a.findIndex((line, n) => line !== b[n]);
  const at = i < 0 ? a.length : i;
  return `${unit} ${at + 1}: настоящий даёт «${a[at] ?? '(конца нет)'}»,`
    + ` перёд на Sable — «${b[at] ?? '(конца нет)'}»`;
}

function compare(stage: Stage, name: string, source: string, expectedFile: string, got: string | undefined): boolean {
  let expected: string;
  try {
    expected = stage.real(source, expectedFile);
  } catch {
    expected = REFUSED;
  }
  if (got === undefined) { fail(name, 'перёд на Sable ничего не выдал'); return false; }
  if (got === expected) return true;
  if (expected === REFUSED) { fail(name, 'настоящий перёд отказался, перёд на Sable разобрал'); return false; }
  if (got === REFUSED) { fail(name, 'перёд на Sable отказался, настоящий разобрал'); return false; }
  fail(name, firstDiff(expected, got, stage.unit));
  return false;
}

function runStage(stage: Stage, files: string[]): void {
  let streams: Map<string, string>;
  try {
    streams = selfhost(stage.driver, files);
  } catch (e) {
    fail(`${stage.name}: запуск переда на Sable`, (e as Error).message);
    return;
  }

  let matched = 0;
  let real = 0;
  const before = problems.length;
  for (const path of files) {
    const name = relative(ROOT, path);
    const got = streams.get(path);
    if (got !== undefined && got !== REFUSED) real++;
    if (compare(stage, `${stage.name}: ${name}`, readFileSync(path, 'utf8'), name, got)) matched++;
  }
  // Совпавший отказ — тоже совпадение, поэтому перёд, который отказывается
  // всегда, прошёл бы сверку целиком. Требуем, чтобы разобранных было
  // большинство: в репозитории заведомо битых файлов меньше двух десятков.
  if (real < files.length - 40) {
    fail(`${stage.name}: слишком много отказов`, `разобрано ${real} из ${files.length}`);
  }
  if (problems.length === before) {
    ok(`${stage.name}: ${matched} файлов репозитория сошлись, из них разобрано ${real}`);
  }

  const box = mkdtempSync(join(tmpdir(), 'sable-selfhost-'));
  const cases = stage.tricky.map(([name, src], i) => {
    const path = join(box, `case${i}.sable`);
    writeFileSync(path, src, 'utf8');
    return { name, src, path };
  });
  try {
    const got = selfhost(stage.driver, cases.map((c) => c.path));
    for (const c of cases) {
      if (compare(stage, `${stage.name}: ${c.name}`, c.src, c.name, got.get(c.path))) ok(`${stage.name}: ${c.name}`);
    }
  } catch (e) {
    fail(`${stage.name}: трудные записи`, (e as Error).message);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

// ---- что сверяем -----------------------------------------------------------

const LEXER_TRICKY: Array<[string, string]> = [
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

const PARSER_TRICKY: Array<[string, string]> = [
  // Приоритеты, которые легче всего перепутать.
  ['степень правоассоциативна', 'print(2 ^ 3 ^ 2)\n'],
  ['степень крепче унарного минуса', 'print(-2 ^ 2)\n'],
  ['диапазон между сравнением и сложением', 'print(1 + 2..3 * 4 == x)\n'],
  ['«??» слабее «||»', 'print(a ?? b || c && d)\n'],
  ['тернарное правоассоциативно', 'print(a ? b : c ? d : e)\n'],
  ['присваивание правоассоциативно', 'a = b = c\n'],
  ['составное присваивание хранит оператор', 'xs[i()] += 1\nm.поле *= 2\n'],

  // Формы функций.
  ['короткая лямбда', 'print(xs.map(x -> x * 2))\n'],
  ['лямбда со скобками', 'print(f((a, b) -> a + b))\n'],
  ['лямбда без аргументов', 'print(f(() -> 1))\n'],
  ['скобки, которые не лямбда', 'print((a + b) * c)\n'],
  ['fn со стрелкой', 'let f = fn (x) -> x + 1\n'],
  ['именованная функция как значение', 'let f = fn имя(x) { return x }\n'],

  // Словарь против блока.
  ['словарь в условии нужно брать в скобки', 'if ({а: 1}).len() > 0 { print(1) }\n'],
  ['вычисляемый ключ', 'let m = {[k + 1]: 2, 3: "три", true: "да", "с пробелом": 1}\n'],
  ['словарь с переносами и висячей запятой', 'let m = {\n  а: 1,\n  б: 2,\n}\n'],
  ['пустые список и словарь', 'print([], {})\n'],

  // Инструкции.
  ['else if цепочкой', 'if a { print(1) } else if b { print(2) } else { print(3) }\n'],
  ['«}» и «else» на разных строках', 'if a {\n  print(1)\n}\nelse {\n  print(2)\n}\n'],
  ['try/catch/finally', 'try { f() } catch e { g(e) } finally { h() }\n'],
  ['try без catch', 'try { f() }\nfinally { h() }\n'],
  ['catch без имени', 'try { f() } catch { g() }\n'],
  ['return без значения', 'fn f() {\n  return\n}\n'],
  ['пустой блок как инструкция', '{\n}\n'],
  ['точка с запятой вместо переноса', 'let a = 1; let b = 2; print(a, b)\n'],

  // Импорт.
  ['импорт целиком', 'import "u.sable" as u\n'],
  ['выборочный импорт с переименованием', 'import "u.sable" as {а, б as в}\n'],

  // Структуры.
  ['структура с полями и методами', 'struct T {\n  x = 1\n  y\n  fn m(a, b = 2) { return a }\n}\n'],

  // Отказы: оба перёда обязаны отказаться одновременно.
  ['битый синтаксис', 'fn f(a b) { return a }\n'],
  ['try без catch и finally', 'try { f() }\n'],
  ['присваивание не переменной', 'f() = 1\n'],
  ['повтор параметра', 'fn f(a, a) { return a }\n'],
  ['обязательный параметр после необязательного', 'fn f(a = 1, b) { return a }\n'],
  ['повтор имени в структуре', 'struct T {\n  x\n  fn x() { return 1 }\n}\n'],
  ['имя дважды в списке импорта', 'import "u.sable" as {а, б as а}\n'],
  ['пустой список импорта', 'import "u.sable" as {}\n'],
  ['import внутри блока', 'fn f() {\n  import "u.sable" as u\n}\n'],
  ['второй finally', 'try { f() } finally { a() } finally { b() }\n'],
  ['finally без try', 'finally { a() }\n'],
  ['словарь там, где ждут тело', 'if {а: 1} { print(1) }\n'],

  ['пустой файл', ''],
  ['только комментарий', '// ничего\n'],
];

const STAGES: Stage[] = [
  {
    name: 'лексемы',
    driver: 'main.sable',
    real: (source, file) => canonTokens(tokenize(source, file)),
    unit: 'лексема',
    tricky: LEXER_TRICKY,
  },
  {
    name: 'дерево',
    driver: 'дерево.sable',
    real: (source, file) => reprProgram(parse(tokenize(source, file), file)),
    unit: 'узел',
    tricky: PARSER_TRICKY,
  },
];

const files = sableFiles(ROOT);
if (files.length < 30) fail('поиск файлов', `нашлось всего ${files.length} — похоже, обход сломан`);

for (const stage of STAGES) runStage(stage, files);

const total = 2 + LEXER_TRICKY.length + PARSER_TRICKY.length;
process.stdout.write(
  problems.length === 0
    ? `\nсамоприменение: ${total}/${total} прошло (${files.length} файлов сверено дважды)\n`
    : `\nсамоприменение: расхождений ${problems.length}\n\n${problems.join('\n')}\n`,
);
if (problems.length > 0) process.exitCode = 1;
