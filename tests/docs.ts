// Проверка документации: каждый блок кода, за которым в тексте напечатан вывод,
// выполняется по-настоящему, и результат сверяется с напечатанным.
//
// Смысл в том, что документация с выдуманным выводом хуже отсутствующей: читатель
// повторяет пример, получает другое — и перестаёт верить всему остальному.
//
// Блоки без напечатанного вывода пропускаются — это фрагменты, а не программы.
//
// Запуск: node tests/docs.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  join(ROOT, 'README.md'),
  ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort()
    .map((f) => join(ROOT, 'docs', f)),
];
const CLI = join(ROOT, 'src', 'cli.ts');

type Snippet = { code: string; expected: string; line: number; doc: string };

/** Пары «блок кода → блок ожидаемого вывода», идущие подряд. */
function extract(markdown: string, doc: string): Snippet[] {
  const lines = markdown.split('\n');
  const out: Snippet[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '```dbgo') continue;
    const codeStart = i + 1;
    let j = codeStart;
    while (j < lines.length && lines[j] !== '```') j++;
    const code = lines.slice(codeStart, j).join('\n');

    // Между блоками допускаются пустые строки — но не текст: иначе это не пара.
    let k = j + 1;
    while (k < lines.length && lines[k]!.trim() === '') k++;
    if (lines[k] !== '```text') { i = j; continue; }

    const outStart = k + 1;
    let m = outStart;
    while (m < lines.length && lines[m] !== '```') m++;
    out.push({ code, expected: lines.slice(outStart, m).join('\n'), line: codeStart + 1, doc });
    i = m;
  }
  return out;
}

/** Запуск во временной папке: файл называется demo.dbgo, как в тексте учебника. */
function run(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dbgo-tutorial-'));
  const file = join(dir, 'demo.dbgo');
  writeFileSync(file, code.endsWith('\n') ? code : code + '\n', 'utf8');
  try {
    return execFileSync('node', [CLI, 'demo.dbgo'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? '') + (err.stderr ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const snippets = DOCS.flatMap((path) =>
  extract(readFileSync(path, 'utf8'), path.slice(ROOT.length + 1)));
let passed = 0;
const failures: string[] = [];

for (const s of snippets) {
  const actual = run(s.code).replace(/\s+$/, '');
  const expected = s.expected.replace(/\s+$/, '');
  if (actual === expected) {
    passed++;
    process.stdout.write(`  ✓ ${s.doc}:${s.line}\n`);
    continue;
  }
  process.stdout.write(`  ✗ ${s.doc}:${s.line}\n`);
  const a = actual.split('\n');
  const e = expected.split('\n');
  const diff: string[] = [];
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] === e[i]) continue;
    diff.push(`      строка ${i + 1}`);
    diff.push(`        в документе: ${e[i] === undefined ? '<нет строки>' : JSON.stringify(e[i])}`);
    diff.push(`        на деле:     ${a[i] === undefined ? '<нет строки>' : JSON.stringify(a[i])}`);
    if (diff.length > 12) { diff.push('      ...'); break; }
  }
  failures.push(`${s.doc}:${s.line}\n${diff.join('\n')}`);
}

process.stdout.write(`\n${passed}/${snippets.length} блоков документации совпали\n`);
if (failures.length) {
  process.stdout.write('\n' + failures.join('\n\n') + '\n');
  process.exitCode = 1;
}
