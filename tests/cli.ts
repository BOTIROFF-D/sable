// Проверка самой команды: коды выхода, потоки вывода и поведение при обрыве.
//
// Остальные наборы гоняют интерпретатор напрямую, минуя `cli.ts`, поэтому
// всё, что происходит на уровне процесса, до сих пор не проверялось ничем.
// Первым же, что тут нашлось, был вываленный наружу стек Node при
// `sable программа.sable | head` — самая обычная команда в терминале.
//
// Процесс запускается массивом аргументов, без оболочки: разбор кавычек
// оболочкой — источник ложных выводов, а не проверок.
//
// Запуск: node tests/cli.ts
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const BOX = mkdtempSync(join(tmpdir(), 'sable-cli-'));

const problems: string[] = [];
const ok = (what: string) => process.stdout.write(`  ✓ ${what}\n`);
const fail = (what: string, why: string) => {
  process.stdout.write(`  ✗ ${what}\n`);
  problems.push(`${what}: ${why}`);
};

const file = (name: string, text: string): string => {
  const path = join(BOX, name);
  writeFileSync(path, text, 'utf8');
  return path;
};

const OK = file('ok.sable', 'print("готово")\n');
const SYNTAX = file('syntax.sable', 'fn f(a b) { return a }\n');
const RUNTIME = file('runtime.sable', 'print(нету)\n');
const UNFORMATTED = file('unfmt.sable', 'let  x=1\nif x>0 { print( x ) }\n');
const MISSING = join(BOX, 'нет-такого.sable');

type Run = { code: number; out: string; err: string };

const run = (args: string[], stdin = ''): Run => {
  const r = spawnSync(process.execPath, [CLI, ...args], { input: stdin, encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
};

/** Следы внутренностей JavaScript пользователю Sable видеть незачем — никогда. */
const JS_LEAK = ['node:internal', 'node:events', '    at ', 'ReferenceError', 'TypeError', 'EPIPE'];
const leakIn = (text: string): string | undefined => JS_LEAK.find((mark) => text.includes(mark));

type Case = {
  name: string;
  args: string[];
  stdin?: string;
  code: number;
  /** Что обязано встретиться в объединённом выводе. */
  expect?: string;
  /** В каком потоке ожидается сообщение: важно для конвейеров. */
  stream?: 'out' | 'err';
};

const CASES: Case[] = [
  { name: 'версия', args: ['--version'], code: 0, expect: 'Sable 0.2.0', stream: 'out' },
  { name: 'справка', args: ['--help'], code: 0, expect: 'привести к каноническому виду', stream: 'out' },
  { name: 'строка кода', args: ['-e', 'print(2 ^ 10)'], code: 0, expect: '1024', stream: 'out' },
  { name: '-e без кода', args: ['-e'], code: 64 },
  { name: 'файл выполняется', args: [OK], code: 0, expect: 'готово', stream: 'out' },
  { name: 'нет файла', args: [MISSING], code: 66, expect: 'не удалось открыть файл', stream: 'err' },

  // Ошибки уходят в поток ошибок, а не в вывод: иначе они попадали бы
  // в конвейер вместе с полезными данными.
  { name: 'синтаксис: код 65', args: [SYNTAX], code: 65, expect: 'Ошибка синтаксиса', stream: 'err' },
  { name: 'выполнение: код 70', args: [RUNTIME], code: 70, expect: 'не определено', stream: 'err' },

  { name: 'проверка чистого', args: ['--check', OK], code: 0, expect: 'замечаний нет', stream: 'out' },
  { name: 'проверка с ошибкой', args: ['--check', RUNTIME], code: 65, expect: 'не определено', stream: 'out' },
  { name: 'проверка с синтаксисом', args: ['--check', SYNTAX], code: 65, expect: 'Ошибка синтаксиса', stream: 'err' },

  { name: 'форматирование печатает', args: ['fmt', UNFORMATTED], code: 0, expect: 'let x = 1', stream: 'out' },
  { name: 'fmt -c ловит неформатированное', args: ['fmt', '-c', UNFORMATTED], code: 1, expect: 'не отформатирован', stream: 'out' },
  { name: 'fmt -c молчит на каноничном', args: ['fmt', '-c', join(ROOT, 'tests', 'cases', '01_literals.sable')], code: 0 },
  { name: 'fmt без пути', args: ['fmt'], code: 64 },
  { name: 'fmt -w и -c вместе', args: ['fmt', '-w', '-c', UNFORMATTED], code: 64 },

  { name: 'интерактивный режим считает', args: [], stdin: 'let a = 1\na + 41\n', code: 0, expect: '42', stream: 'out' },
  { name: 'интерактивный режим переживает ошибку', args: [], stdin: 'нету\nprint("живой")\n', code: 0, expect: 'живой', stream: 'out' },
];

for (const c of CASES) {
  const r = run(c.args, c.stdin ?? '');
  const both = r.out + r.err;

  const leak = leakIn(both);
  if (leak) { fail(c.name, `наружу вышли внутренности: «${leak}»`); continue; }
  if (r.code !== c.code) { fail(c.name, `код выхода ${r.code}, ожидался ${c.code}`); continue; }

  if (c.expect !== undefined) {
    const where = c.stream === 'err' ? r.err : c.stream === 'out' ? r.out : both;
    if (!where.includes(c.expect)) {
      fail(c.name, `в потоке ${c.stream ?? 'любом'} нет «${c.expect}»; получено: ${JSON.stringify(where.slice(0, 120))}`);
      continue;
    }
  }
  ok(c.name);
}

// ---- обрыв канала ---------------------------------------------------------

/**
 * `sable программа.sable | head` — получатель уходит, не дочитав. Node без
 * обработчика роняет наружу необработанное событие ошибки, то есть свой стек.
 */
const brokenPipe = await new Promise<string>((resolve) => {
  const child = spawn(process.execPath, [CLI, '-e', 'for i in 0..200000 { print(i) }'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  child.stdout.once('data', () => child.stdout.destroy());
  child.on('close', () => resolve(err));
  setTimeout(() => { child.kill('SIGKILL'); resolve(err); }, 15000);
});

const pipeLeak = leakIn(brokenPipe);
if (pipeLeak) fail('обрыв канала', `наружу вышли внутренности: «${pipeLeak}»`);
else if (brokenPipe.trim() !== '') fail('обрыв канала', `в поток ошибок что-то ушло: ${JSON.stringify(brokenPipe.slice(0, 120))}`);
else ok('обрыв канала проходит тихо');

rmSync(BOX, { recursive: true, force: true });

const total = CASES.length + 1;
process.stdout.write(
  problems.length === 0
    ? `\nкоманда: ${total}/${total} прошло\n`
    : `\nкоманда: расхождений ${problems.length}\n\n${problems.join('\n')}\n`,
);
if (problems.length > 0) process.exitCode = 1;
