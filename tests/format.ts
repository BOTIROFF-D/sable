// Тесты форматтера: node tests/format.ts
//
// Три уровня проверки, от самого важного к частному:
//   1. смысл — программа после форматирования разбирается в то же дерево
//      и печатает то же самое; ни один комментарий не потерян;
//   2. идемпотентность — format(format(x)) === format(x) на всех .dbgo репозитория;
//   3. правила — набор «кривой вход → канонический выход», по кейсу на правило.
//
// Ненулевой код выхода при любом расхождении.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Program } from '../src/ast.ts';
import { DbgoError, forgetSources, formatError, formatErrors, registerSource } from '../src/errors.ts';
import { format, sourceComments } from '../src/format.ts';
import { Interpreter } from '../src/interpreter.ts';
import { tokenize } from '../src/lexer.ts';
import { parse, parseAll } from '../src/parser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, 'cases');
const EXAMPLES = join(HERE, '..', 'examples');

let passed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; return; }
  failures.push(detail === '' ? name : `${name}\n${detail}`);
}

/** Первое расхождение двух текстов — читать целиком незачем. */
function firstDiff(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] === a[i]) continue;
    return `    строка ${i + 1}:\n      ожидалось: ${JSON.stringify(e[i] ?? null)}\n      получено:  ${JSON.stringify(a[i] ?? null)}`;
  }
  return '';
}

function eq(name: string, actual: string, expected: string): void {
  ok(name, actual === expected, firstDiff(expected, actual));
}

/**
 * Дерево без позиций: форматтер двигает код по строкам, поэтому span сравнивать
 * нельзя, а всё остальное обязано совпасть до буквы. Словесные синонимы
 * логических операторов приводятся к знакам — форматтер печатает их так.
 */
function astKey(program: Program): string {
  return JSON.stringify(program, (key, value) => {
    if (key === 'span') return undefined;
    if (key === 'op') return value === 'and' ? '&&' : value === 'or' ? '||' : value;
    return value;
  });
}

/** Прогон исходника с перехватом вывода — как это делает CLI и tests/run.ts. */
function run(source: string, file: string, fullPath: string): string {
  let out = '';
  forgetSources();
  registerSource(file, source);
  const interp = new Interpreter({ write: (t) => { out += t; } }, fullPath);
  try {
    const parsed = parseAll(tokenize(source, file), file);
    if (parsed.errors.length > 0) return out + formatErrors(parsed.errors, source) + '\n';
    interp.run(parsed.program);
  } catch (e) {
    if (e instanceof DbgoError) out += formatError(e, source) + '\n';
    else out += `ВНУТРЕННЯЯ ОШИБКА: ${(e as Error).message}\n`;
  }
  return out;
}

/**
 * Вывод без привязки к номерам строк. Форматирование двигает код, поэтому
 * в тексте ошибки меняются позиция и показанная строка исходника — это
 * единственное, чему меняться можно. Всё остальное сверяется дословно.
 */
function withoutPositions(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*\d* \|/.test(l))
    .map((l) => l.replace(/:\d+:\d+/g, ':строка:колонка'))
    .join('\n');
}

// ---- 1. все файлы репозитория ---------------------------------------------

type Sample = { file: string; dir: string };
const collect = (dir: string): Sample[] =>
  readdirSync(dir).filter((f) => f.endsWith('.dbgo')).sort().map((file) => ({ file, dir }));

for (const { file, dir } of [...collect(CASES), ...collect(EXAMPLES)]) {
  const full = join(dir, file);
  const source = readFileSync(full, 'utf8');

  let broken = false;
  try { parse(tokenize(source, file), file); } catch { broken = true; }

  if (broken) {
    // Сломанный код форматтер обязан отвергнуть, а не чинить на свой вкус.
    let threw = false;
    try { format(source, file); } catch (e) { threw = e instanceof DbgoError; }
    ok(`${file}: ошибка разбора летит наружу`, threw);
    continue;
  }

  let once: string;
  try {
    once = format(source, file);
  } catch (e) {
    ok(`${file}: форматируется`, false, `    ${(e as Error).message}`);
    continue;
  }

  let twice: string | null = null;
  try {
    twice = format(once, file);
  } catch (e) {
    ok(`${file}: вывод форматтера разбирается`, false, `    ${(e as Error).message}`);
  }

  if (twice !== null) eq(`${file}: идемпотентность`, twice, once);

  eq(
    `${file}: дерево не изменилось`,
    astKey(parse(tokenize(once, file), file)),
    astKey(parse(tokenize(source, file), file)),
  );

  eq(
    `${file}: комментарии на месте`,
    sourceComments(once).join('\n'),
    sourceComments(source).join('\n'),
  );

  eq(
    `${file}: вывод программы не изменился`,
    withoutPositions(run(once, file, full)),
    withoutPositions(run(source, file, full)),
  );
}

// ---- 2. правила оформления --------------------------------------------------

type Case = { name: string; input: string; expect: string };

const CASE_LIST: Case[] = [
  {
    name: 'отступ два пробела, табы уходят',
    input: 'fn f(a) {\n\tif a {\n\t\t\tprint(a)\n\t}\n}\n',
    expect: 'fn f(a) {\n  if a { print(a) }\n}\n',
  },
  {
    name: 'скобка заголовка на своей строке, else и catch — на строке «}»',
    input: 'if a { f() }\nelse { g() }\ntry { h() }\ncatch e { print(e) }\n',
    expect: 'if a {\n  f()\n} else {\n  g()\n}\ntry {\n  h()\n} catch e {\n  print(e)\n}\n',
  },
  {
    name: 'цепочка else if не расползается лесенкой',
    input: 'if a { x() } else if b { y() } else { z() }\n',
    expect: 'if a {\n  x()\n} else if b {\n  y()\n} else {\n  z()\n}\n',
  },
  {
    name: 'пробелы вокруг бинарных, ничего после унарных, «..» вплотную',
    input: 'let a = 1+2*3\nlet b = - x\nlet c = ! ready\nfor i in 0 .. 10 { print(i) }\n',
    expect: 'let a = 1 + 2 * 3\nlet b = -x\nlet c = !ready\nfor i in 0..10 { print(i) }\n',
  },
  {
    name: 'скобки только те, что нужны',
    input: 'let a = ((1 + 2)) * ((3))\nlet b = -2 ^ 2\nlet c = (-2) ^ 2\nlet d = (a ? b : c) ? d : e\n',
    expect: 'let a = (1 + 2) * 3\nlet b = -2 ^ 2\nlet c = (-2) ^ 2\nlet d = (a ? b : c) ? d : e\n',
  },
  {
    name: 'словарь в заголовке цикла берётся в скобки',
    input: 'for k in ({a: 1}) { print(k) }\n',
    expect: 'for k in ({a: 1}) { print(k) }\n',
  },
  {
    // Скобок вокруг словаря в AST нет, и снять их в заголовке значит выдать
    // код, который не разберётся. Внутри «(…)» и «[…]» словарь снова однозначен.
    name: 'словарь в глубине заголовка тоже в скобках, а внутри «(…)» и «[…]» — нет',
    input: 'if !a || ({m: 1}).has("k") { g() }\nif f({m: 1}) { g() }\nwhile xs[({m: 1}).len()] { g() }\n',
    expect: 'if !a || ({m: 1}).has("k") { g() }\nif f({m: 1}) { g() }\nwhile xs[{m: 1}.len()] { g() }\n',
  },
  {
    name: 'нет пробела перед «(» и перед «,», есть после «,»',
    input: 'print ( 1 , 2 ,3 )\n',
    expect: 'print(1, 2, 3)\n',
  },
  {
    name: 'короткий список остаётся одной строкой, висячая запятая уходит',
    input: 'let xs = [\n  1,\n  2,\n]\n',
    expect: 'let xs = [1, 2]\n',
  },
  {
    name: 'длинный список коротких значений заполняет строки, а не растягивается в столбец',
    input: 'let xs = [100000001, 100000002, 100000003, 100000004, 100000005, 100000006, 100000007, 100000008, 99]\n',
    expect: 'let xs = [\n  100000001, 100000002, 100000003, 100000004, 100000005, 100000006, 100000007,'
      + ' 100000008, 99,\n]\n',
  },
  {
    name: 'список с длинными элементами всё равно идёт по элементу на строку',
    input: 'let xs = ["очень длинная строка номер один", "очень длинная строка номер два", '
      + '"очень длинная строка номер три"]\n',
    expect: 'let xs = [\n  "очень длинная строка номер один",\n  "очень длинная строка номер два",\n'
      + '  "очень длинная строка номер три",\n]\n',
  },
  {
    name: 'ключи словаря без кавычек, где можно, и с кавычками, где нельзя',
    input: 'let m = { "имя" : "Ali" , возраст:20 , "с пробелом" : true , [k] : 1 , 2 : "два" }\n',
    expect: 'let m = {имя: "Ali", возраст: 20, "с пробелом": true, [k]: 1, 2: "два"}\n',
  },
  {
    name: 'строковые литералы переносятся как есть',
    input: "let a = 'одинарные'\nlet b = `много\nстрок ${1 + 1}`\nlet c = \"\\tтаб и \\u{41}\"\n",
    expect: "let a = 'одинарные'\nlet b = `много\nстрок ${1 + 1}`\nlet c = \"\\tтаб и \\u{41}\"\n",
  },
  {
    name: 'числа сохраняют исходную запись',
    input: 'print(0xFF, 1_000_000, 1e3, 2.50)\n',
    expect: 'print(0xFF, 1_000_000, 1e3, 2.50)\n',
  },
  {
    name: 'между объявлениями верхнего уровня ровно одна пустая строка',
    input: 'let a = 1\nfn f() { return 1 }\n\n\n\nfn g() { return 2 }\nlet b = 2\n',
    expect: 'let a = 1\n\nfn f() { return 1 }\n\nfn g() { return 2 }\n\nlet b = 2\n',
  },
  {
    name: 'подряд идущих пустых строк не бывает больше одной',
    input: 'let a = 1\n\n\n\nlet b = 2\n',
    expect: 'let a = 1\n\nlet b = 2\n',
  },
  {
    name: 'точка с запятой заменяется переводом строки',
    input: 'let a = 1; let b = 2\n',
    expect: 'let a = 1\nlet b = 2\n',
  },
  {
    name: 'комментарий на своей строке остаётся своей строкой, хвостовой — хвостом',
    input: '// шапка\nlet a = 1    // про a\nfn f() {\n  g()\n  // конец тела\n}\n',
    expect: '// шапка\nlet a = 1 // про a\n\nfn f() {\n  g()\n  // конец тела\n}\n',
  },
  {
    name: 'структура: поля по строке, перед методами пустая строка',
    input: 'struct P { x = 0, y = 0\n  fn len() { return self.x + self.y }\n  fn zero() { return 0 } }\n',
    expect: 'struct P {\n  x = 0\n  y = 0\n\n  fn len() { return self.x + self.y }\n\n  fn zero() { return 0 }\n}\n',
  },
  {
    name: 'функция-значение из одного return записывается стрелкой',
    input: 'let a = fn(x) { return x * 2 }\nlet b = (x) -> x * 2\nlet c = fn(x, y) -> x + y\n',
    expect: 'let a = x -> x * 2\nlet b = x -> x * 2\nlet c = (x, y) -> x + y\n',
  },
  {
    name: 'тело с комментарием в стрелку не сжимается',
    input: 'let a = fn(x) {\n  // удваиваем\n  return x * 2\n}\n',
    expect: 'let a = fn(x) {\n  // удваиваем\n  return x * 2\n}\n',
  },
  {
    name: 'присваивание не переписывается, словесные операторы печатаются знаками',
    input: 'x = x + 1\nobj.f = obj.f * 2\nx += 1\nlet ok = a and b or not c\n',
    // `x = x + 1` в `x += 1` не переписывается: у составного присваивания цель
    // вычисляется один раз, у развёрнутого — дважды, и это разное поведение.
    expect: 'x = x + 1\nobj.f = obj.f * 2\nx += 1\nlet ok = a && b || !c\n',
  },
  {
    name: 'пустое тело — «{}», но не когда внутри комментарий',
    input: 'fn f() {\n}\nfn g() {\n  // потом\n}\n',
    expect: 'fn f() {}\n\nfn g() {\n  // потом\n}\n',
  },
  {
    name: 'пустой файл остаётся пустым',
    input: '\n\n\n',
    expect: '',
  },
];

for (const c of CASE_LIST) {
  let actual: string;
  try {
    actual = format(c.input, 'случай.dbgo');
  } catch (e) {
    ok(`правило: ${c.name}`, false, `    ${(e as Error).message}`);
    continue;
  }
  eq(`правило: ${c.name}`, actual, c.expect);
  // Каждое правило заодно проверяется на устойчивость.
  try {
    eq(`правило: ${c.name} (идемпотентность)`, format(actual, 'случай.dbgo'), actual);
  } catch (e) {
    ok(`правило: ${c.name} (идемпотентность)`, false, `    ${(e as Error).message}`);
  }
}

// ---- 3. трудные места ------------------------------------------------------

// Здесь важен не текст, а два свойства: дерево не поехало и повтор ничего
// не меняет. Записывать эталон для каждого такого куска — держать в тесте
// вторую копию форматтера.
const HARD: string[] = [
  'let a = 2 ^ 3 ^ 2\nlet b = (2 ^ 3) ^ 2\nlet c = -2 ^ 2\nlet d = (-2) ^ 2\nlet e = -(a + b)\n',
  'let x = a ?? b ?? c\nlet y = a ? b : c ? d : e\nlet z = (a ? b : c) ? d : e\n',
  'let v = xs[i + 1][2].f(1)(2).g\nlet w = f(g(h(1, 2), 3), 4)\n',
  'a = b = c\nxs[i()] = xs[i()] + 1\nm.n -= 1\n',
  'let f = (x -> x)(5)\nlet g = (fn(n) { return n * n })(7)\nlet h = () -> 42\n',
  'for i in 0..3 { fns.push(fn() -> i) }\nwhile x < 10 { x += 1; if x == 5 { break } else { continue } }\n',
  'try { error({код: 404}) } catch { print("нет") }\n',
  'struct S { }\nstruct T { a }\nstruct U { fn m() { return 1 } }\n',
  'import "lib/math.dbgo" as math\nprint(math.pi)\n',
  'print(`строка\nв две`, "вставка ${ a + b } тут", \'третья\')\n',
  'let m = {"true": 1, true: 2, "if": 3, "1": 4, 1: 5}\n',
  'let nested = [[1, [2, [3, [4]]]], {a: {b: {c: [5]}}}]\n',
  '/* блочный */ let a = 1 /* хвост */\n// строка\n/* два\n   уровня /* вложенный */ */\nlet b = 2\n',
  'print(xs.map(x -> x * 2).filter(x -> x > 2).reduce((a, b) -> a + b, 0))\n',
  'fn f(a, b = a, c = [1, 2]) { return a }\nlet r = f(1, 2, [3])\n',
];

for (let i = 0; i < HARD.length; i++) {
  const source = HARD[i]!;
  const name = `трудный случай ${i + 1}`;
  let once: string;
  try {
    once = format(source, 'трудный.dbgo');
  } catch (e) {
    ok(name, false, `    ${(e as Error).message}`);
    continue;
  }
  try {
    eq(`${name}: идемпотентность`, format(once, 'трудный.dbgo'), once);
    eq(
      `${name}: дерево не изменилось`,
      astKey(parse(tokenize(once, 'трудный.dbgo'), 'трудный.dbgo')),
      astKey(parse(tokenize(source, 'трудный.dbgo'), 'трудный.dbgo')),
    );
    eq(
      `${name}: комментарии на месте`,
      sourceComments(once).join('\n'),
      sourceComments(source).join('\n'),
    );
  } catch (e) {
    ok(name, false, `    вывод форматтера не разбирается: ${(e as Error).message}\n${once}`);
  }
}

// ---- итог ------------------------------------------------------------------

process.stdout.write(`\nформаттер: ${passed}/${passed + failures.length} прошло\n`);
if (failures.length > 0) {
  process.stdout.write('\n' + failures.map((f) => `  ✗ ${f}`).join('\n') + '\n');
  process.exitCode = 1;
}
