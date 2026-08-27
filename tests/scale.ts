// Замок на сложность работы со строками: посимвольный проход обязан расти
// линейно от длины, а не квадратично.
//
// Появился после настоящего дефекта. Строка в языке измеряется в символах, а в
// JavaScript — в кодовых единицах UTF-16, и перевод между ними шёл заново на
// каждое обращение: `len(s)` и `s[i]` пересчитывали строку целиком. Пока строки
// короткие, этого не видно ни в одном тесте. Лексер Sable, написанный на Sable,
// упёрся в это сразу: файл в 300 КБ он разбирал минутами вместо секунды.
//
// Меряется не время, а его рост: длина берётся вчетверо больше, и время обязано
// вырасти примерно вчетверо. Квадрат дал бы шестнадцать. Порог посередине —
// чтобы шум машины не валил набор и не прятал возврат дефекта.
//
// Запуск: node tests/scale.ts
import { Interpreter } from '../src/interpreter.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';

const problems: string[] = [];
const ok = (what: string, ratio: number) =>
  process.stdout.write(`  ✓ ${what}: вчетверо длиннее — ${ratio.toFixed(1)}× дольше\n`);
const fail = (what: string, why: string) => {
  process.stdout.write(`  ✗ ${what}\n`);
  problems.push(`${what}: ${why}`);
};

/** Квадрат дал бы 16, линия — 4. Всё, что ниже порога, линией и считаем. */
const LIMIT = 8;
const SHORT = 20_000;
const LONG = SHORT * 4;

function time(source: string): number {
  const program = parse(tokenize(source, 'замер'), 'замер');
  const run = () => {
    const interp = new Interpreter({ write: () => {} }, '/замер.sable');
    const t0 = performance.now();
    interp.run(program);
    return performance.now() - t0;
  };
  run(); // прогрев: первый прогон платит за JIT
  let best = Infinity;
  for (let i = 0; i < 3; i++) best = Math.min(best, run());
  return best;
}

type Case = { name: string; body: (chars: number) => string };

const CASES: Case[] = [
  {
    name: 'обращение по индексу',
    body: (n) => `let s = "abcdefghij" * ${n / 10}
let i = 0
let найдено = 0
while i < ${n} {
  if s[i] == "e" { найдено += 1 }
  i += 1
}
print(найдено)`,
  },
  {
    // Кириллица важна отдельно: в JavaScript такая строка хранится по два байта
    // на символ, и быстрая проверка «нет ли суррогатных пар» на ней уже не
    // бесплатна — на латинице движок отвечает не глядя, здесь честно читает.
    name: 'обращение по индексу, кириллица',
    body: (n) => `let s = "абвгдежзий" * ${n / 10}
let i = 0
let найдено = 0
while i < ${n} {
  if s[i] == "е" { найдено += 1 }
  i += 1
}
print(найдено)`,
  },
  {
    name: 'длина в цикле',
    body: (n) => `let s = "abcdefghij" * ${n / 10}
let i = 0
while i < len(s) { i += 1 }
print(i)`,
  },
  {
    name: 'срез в цикле',
    body: (n) => `let s = "abcdefghij" * ${n / 10}
let i = 0
let найдено = 0
while i < ${n} - 3 {
  if s.slice(i, i + 3) == "cde" { найдено += 1 }
  i += 1
}
print(найдено)`,
  },
];

for (const c of CASES) {
  const short = time(c.body(SHORT));
  const long = time(c.body(LONG));
  const ratio = long / short;
  if (ratio > LIMIT) {
    fail(c.name, `рост в ${ratio.toFixed(1)} раза при учетверении длины — это похоже на квадрат`);
  } else {
    ok(c.name, ratio);
  }
}

// Отдельно — строка с суррогатными парами. Быстрого пути у неё нет и быть не
// может: символ там занимает две кодовые единицы, и позицию приходится искать
// пересчётом. Проверяем не рост, а что цена осталась прежней — эта ветка кода
// не менялась, и незаметно испортить её было бы легко.
const WIDE_LIMIT = 2000;
const wide = time(`let s = "аб😀вг" * 200
let i = 0
let n = 0
while i < 1000 { if s[i] == "😀" { n += 1 }; i += 1 }
print(n)`);
if (wide > WIDE_LIMIT) fail('строка с эмодзи', `${wide.toFixed(0)} мс при пределе ${WIDE_LIMIT}`);
else process.stdout.write(`  ✓ строка с эмодзи: ${wide.toFixed(0)} мс, предел ${WIDE_LIMIT}\n`);

process.stdout.write(
  problems.length === 0
    ? `\nсложность: ${CASES.length + 1}/${CASES.length + 1} прошло\n`
    : `\nсложность: расхождений ${problems.length}\n\n${problems.join('\n')}\n`,
);
if (problems.length > 0) process.exitCode = 1;
