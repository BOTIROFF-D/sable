// Замок на песочницу: собранные для браузера файлы не должны тянуть за собой
// ничего из Node, а логика — вести себя так же, как в терминале.
//
// Появился после настоящего дефекта: воркер падал в браузере с
// `ReferenceError: process is not defined`, потому что интерпретатор читает
// `process.env` при загрузке модуля. В Node это незаметно — там `process` есть,
// и проверка «собрал и запустил в Node» такую утечку пропускает.
//
// Запуск: node tests/web.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const problems: string[] = [];
const ok = (what: string) => process.stdout.write(`  ✓ ${what}\n`);
const fail = (what: string, why: string) => {
  process.stdout.write(`  ✗ ${what}\n`);
  problems.push(`${what}: ${why}`);
};

// ---- сборка ---------------------------------------------------------------

try {
  execFileSync('npm', ['run', '--silent', 'build:web'], { cwd: ROOT, stdio: 'pipe' });
  ok('песочница собирается');
} catch (e) {
  fail('сборка', `не удалось собрать: ${(e as Error).message}`);
  process.stdout.write('\nдальше проверять нечего\n');
  process.exitCode = 1;
  throw new Error('сборка песочницы не прошла');
}

// ---- ничего от Node в сборке ----------------------------------------------

/**
 * Имена, которых в браузере нет. Каждое из них хоть раз да встречается в коде
 * интерпретатора, и без подмены при сборке страница падает при первом же вызове.
 */
const FORBIDDEN = ['process.', 'Buffer.', 'require(', '__dirname', 'node:fs', 'node:path', 'node:os'];

for (const name of ['worker.js', 'highlight.js']) {
  const code = readFileSync(join(ROOT, 'web', 'dist', name), 'utf8');
  const found = FORBIDDEN.filter((bad) => code.includes(bad));
  if (found.length === 0) ok(`${name} не тянет ничего из Node`);
  else fail(name, `в сборке осталось: ${found.join(', ')}`);
}

// ---- поведение воркера ----------------------------------------------------

type Reply = { ok: boolean; text: string; replaceSource?: string };

const replies: Reply[] = [];
(globalThis as unknown as { self: unknown }).self = { postMessage: (m: Reply) => replies.push(m) };
await import(join(ROOT, 'web', 'dist', 'worker.js'));
const worker = (globalThis as unknown as { self: { onmessage: (e: { data: unknown }) => void } }).self;

const ask = (kind: string, source: string): Reply => {
  replies.length = 0;
  worker.onmessage({ data: { kind, source } });
  return replies[0]!;
};

type Case = { name: string; kind: string; source: string; ok: boolean; expect: string };

const CASES: Case[] = [
  { name: 'печать', kind: 'run', source: 'print("привет", 6 * 7)', ok: true, expect: 'привет 42' },
  { name: 'ошибка со стрелкой', kind: 'run', source: 'let счётчик = 0\nprint(счетчик)', ok: false, expect: 'возможно, имелось в виду «счётчик»' },
  { name: 'синтаксис', kind: 'run', source: 'fn f(a b) { return a }', ok: false, expect: 'Ошибка синтаксиса' },
  { name: 'пустой вывод', kind: 'run', source: 'let x = 1', ok: true, expect: 'ничего не напечатала' },
  { name: 'деление на ноль', kind: 'run', source: 'print(1 / 0)', ok: false, expect: 'деление на ноль' },
  // Файлов и ввода в браузере нет, но наружу обязана выйти ошибка ЯЗЫКА,
  // а не исключение JavaScript из заглушки.
  { name: 'файлы отказывают понятно', kind: 'run', source: 'print(read_file("/x"))', ok: false, expect: 'не удалось прочитать файл' },
  { name: 'ввод отказывает понятно', kind: 'run', source: 'print(input())', ok: false, expect: 'не удалось прочитать ввод' },
  { name: 'модули отказывают понятно', kind: 'run', source: 'import "x.sable" as x', ok: false, expect: 'не удалось прочитать модуль' },
  { name: 'форматирование', kind: 'format', source: 'let  x=1\nif x>0 { print( x ) }', ok: true, expect: 'let x = 1' },
  { name: 'анализ находит', kind: 'check', source: 'fn f(a, b) { return a }\nprint(f(1))', ok: false, expect: 'ожидает 2 аргумента' },
  { name: 'анализ молчит на чистом', kind: 'check', source: 'let a = 1\nprint(a)', ok: true, expect: 'Замечаний нет' },
  { name: 'бесконечный цикл обрывается', kind: 'run', source: 'let i = 0\nwhile true { i += 1; print(i) }', ok: false, expect: 'похоже на бесконечный цикл' },
];

for (const c of CASES) {
  let reply: Reply;
  try {
    reply = ask(c.kind, c.source);
  } catch (e) {
    fail(c.name, `воркер бросил наружу: ${(e as Error).message}`);
    continue;
  }
  const text = String(reply.replaceSource ?? reply.text);

  // Следы внутренностей JavaScript в песочнице — тот же дефект, что и в языке.
  const leak = ['ReferenceError', 'TypeError', 'undefined is not', 'is not defined']
    .find((mark) => text.includes(mark));
  if (leak) { fail(c.name, `наружу вышли внутренности: «${leak}»`); continue; }

  if (reply.ok !== c.ok) { fail(c.name, `ожидался итог ${c.ok ? 'успех' : 'ошибка'}, получен обратный`); continue; }
  if (!text.includes(c.expect)) { fail(c.name, `в ответе нет «${c.expect}»; ответ: ${JSON.stringify(text.slice(0, 120))}`); continue; }
  ok(c.name);
}

process.stdout.write(
  problems.length === 0
    ? `\nпесочница: ${CASES.length + 3}/${CASES.length + 3} прошло\n`
    : `\nпесочница: расхождений ${problems.length}\n\n${problems.join('\n')}\n`,
);
if (problems.length > 0) process.exitCode = 1;
