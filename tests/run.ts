// Golden-тесты: для каждого tests/cases/X.dbgo вывод должен совпасть с X.expected.
// Запуск:  node tests/run.ts          — проверить
//          node tests/run.ts --update — перезаписать эталоны (после осознанной правки)
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbgoError, forgetSources, formatError, formatErrors, registerSource } from '../src/errors.ts';
import { Interpreter } from '../src/interpreter.ts';
import { tokenize } from '../src/lexer.ts';
import { parseAll } from '../src/parser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, 'cases');
const EXAMPLES = join(HERE, '..', 'examples');
const EXAMPLE_GOLDEN = join(HERE, 'examples');
const update = process.argv.includes('--update');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

/** Прогон файла с перехватом вывода: ошибки печатаются так же, как в CLI. */
function runCase(source: string, file: string, fullPath: string): string {
  let out = '';
  // Исходник под своим отображаемым именем — чтобы ошибка внутри модуля показала свою строку.
  registerSource(file, source);
  const interp = new Interpreter({ write: (t) => { out += t; } }, fullPath);
  try {
    // Разбор с продолжением после ошибки — ровно как в CLI: тест видит то же, что человек.
    const parsed = parseAll(tokenize(source, file), file);
    if (parsed.errors.length > 0) return out + formatErrors(parsed.errors, source) + '\n';
    interp.run(parsed.program);
  } catch (e) {
    if (e instanceof DbgoError) out += formatError(e, source) + '\n';
    else out += `ВНУТРЕННЯЯ ОШИБКА: ${(e as Error).message}\n`;
  }
  return out;
}

function diff(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] === a[i]) continue;
    lines.push(`    строка ${i + 1}:`);
    lines.push(`      ожидалось: ${e[i] === undefined ? '<нет строки>' : JSON.stringify(e[i])}`);
    lines.push(`      получено:  ${a[i] === undefined ? '<нет строки>' : JSON.stringify(a[i])}`);
    if (lines.length > 18) { lines.push('    ...'); break; }
  }
  return lines.join('\n');
}

// Примеры тоже под замком: если поведение языка поедет, они это покажут первыми.
if (!existsSync(EXAMPLE_GOLDEN)) mkdirSync(EXAMPLE_GOLDEN, { recursive: true });

type Case = { file: string; dir: string; goldenDir: string };
const collect = (dir: string, goldenDir: string): Case[] =>
  readdirSync(dir).filter((f) => f.endsWith('.dbgo')).sort().map((file) => ({ file, dir, goldenDir }));

const files = [...collect(CASES, CASES), ...collect(EXAMPLES, EXAMPLE_GOLDEN)]
  .filter((c) => !only || c.file.includes(only));

let passed = 0;
const failures: string[] = [];

for (const { file, dir, goldenDir } of files) {
  const source = readFileSync(join(dir, file), 'utf8');
  const goldenPath = join(goldenDir, file.replace(/\.dbgo$/, '.expected'));
  forgetSources();
  const actual = runCase(source, file, join(dir, file));

  if (update || !existsSync(goldenPath)) {
    writeFileSync(goldenPath, actual, 'utf8');
    process.stdout.write(`  ~ ${file} — эталон записан\n`);
    passed++;
    continue;
  }

  const expected = readFileSync(goldenPath, 'utf8');
  if (expected === actual) {
    passed++;
    process.stdout.write(`  ✓ ${file}\n`);
  } else {
    process.stdout.write(`  ✗ ${file}\n`);
    failures.push(`${file}\n${diff(expected, actual)}`);
  }
}

process.stdout.write(`\n${passed}/${files.length} прошло\n`);
if (failures.length) {
  process.stdout.write('\n' + failures.join('\n\n') + '\n');
  process.exitCode = 1;
}
