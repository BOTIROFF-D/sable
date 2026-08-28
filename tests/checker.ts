// Тесты статической проверки: node tests/checker.ts
//
// Каждый кейс — маленькая программа на sable и список ожидаемых диагностик:
// строгость, строка, колонка и кусок сообщения. Пустой список означает
// «здесь всё в порядке» — это защита от ложных срабатываний, и таких кейсов
// столько же, сколько ловящих.
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { Interpreter } from '../src/interpreter.ts';
import { NativeFn } from '../src/values.ts';
import { check, type Diagnostic } from '../src/checker.ts';

/** Набор встроенных имён передаётся явно — проверка ничего не знает про stdlib. */
// Настоящий список встроенных имён вместе с числом аргументов — тот же, что
// получает проверка при запуске. Свой захардкоженный список устаревал бы молча.
const GLOBALS: Array<string | [string, { name: string; min: number; max: number }]> = [];
for (const [name, value] of new Interpreter({ write: () => {} }).builtins.ownEntries()) {
  GLOBALS.push(value instanceof NativeFn ? [name, { name, min: value.minArgs, max: value.maxArgs }] : name);
}

type Expect = { severity: 'error' | 'warning'; line: number; col: number; match: string };
type Case = { name: string; source: string; expect: Expect[] };

const CASES: Case[] = [
  // ---- 0. область видимости ----------------------------------------------
  {
    name: '0) значение поля структуры видит имя верхнего уровня — не ложное срабатывание',
    source: `const START = "создан"
struct Заказ {
  состояние = START
  след = [START]
}
print(Заказ().состояние, Заказ().след)`,
    expect: [],
  },
  {
    name: '0) значение поля видит предыдущее поле — не ложное срабатывание',
    source: `struct Прямоугольник {
  ширина
  высота = ширина
}
print(Прямоугольник(3).высота)`,
    expect: [],
  },
  {
    name: '0) своё имя поверх встроенного — законное затенение, не ошибка',
    source: `let sum = 0
for x in [1, 2, 3] { sum += x }
print(sum)`,
    expect: [],
  },
  {
    name: '0) присваивание встроенному имени без объявления — ловим',
    source: `print = 1`,
    // Чекер указывает на само имя, интерпретатор — на «=»; обе позиции верны.
    expect: [{ severity: 'error', line: 1, col: 1, match: 'встроенная функция' }],
  },

  {
    name: '0) функция из блока зовёт имя, объявленное ниже файла — не ложное срабатывание',
    source: `{
  fn внутри() { return позже() }
}
fn позже() { return 7 }
print(позже())`,
    expect: [],
  },
  {
    name: '0) счётчик через += считается использованным',
    source: `let n = 0
for i in 0..3 { n += i }
print(n)`,
    expect: [],
  },

  {
    name: '0) опечатка в имени поля при чтении — ловим',
    source: `struct Точка { x, y }
let p = Точка(1, 2)
print(p.у)`,
    expect: [{ severity: 'error', line: 3, col: 8, match: 'у Точка нет поля или метода «у»' }],
  },
  {
    name: '0) неверное число аргументов у метода структуры — ловим',
    source: `struct Точка { x
  fn длина() { return self.x }
}
let p = Точка(1)
print(p.длина(1, 2, 3))`,
    expect: [{ severity: 'error', line: 5, col: 14, match: '«Точка.длина» ожидает 0 аргументов, а получает 3' }],
  },
  {
    name: '0) поле и метод с известным типом — не ложное срабатывание',
    source: `struct Точка { x, y = 0
  fn сумма(k = 1) { return (self.x + self.y) * k }
}
let p = Точка(1, 2)
print(p.x, p.y, p.сумма(), p.сумма(3))`,
    expect: [],
  },
  {
    name: '0) переприсвоенному имени тип не приписываем — молчим',
    source: `struct Точка { x }
let p = Точка(1)
p = {что: "угодно"}
print(p.что)`,
    expect: [],
  },

  {
    name: '0) неверное число аргументов у встроенной функции — ловим',
    source: `print(len())`,
    expect: [{ severity: 'error', line: 1, col: 10, match: '«len» ожидает 1 аргумент, а получает 0' }],
  },
  {
    name: '0) встроенная с переменным числом аргументов — не ложное срабатывание',
    source: `print(1, 2, 3)
print(max(1, 2, 3), min([4, 5]), round(2.5), round(2.567, 2))`,
    expect: [],
  },

  // ---- 1. неизвестное имя -------------------------------------------------
  {
    name: '1) опечатка в имени — ловим и подсказываем',
    source: `let balance = 100
print(balance + blance)`,
    expect: [{ severity: 'error', line: 2, col: 17, match: 'имя «blance» не определено — возможно, имелось в виду «balance»' }],
  },
  {
    name: '1) взаимная рекурсия — не ложное срабатывание',
    source: `fn чёт(n) { return n == 0 ? true : нечёт(n - 1) }
fn нечёт(n) { return n == 0 ? false : чёт(n - 1) }
print(чёт(4))`,
    expect: [],
  },
  {
    name: '1) тело функции видит имя, объявленное ниже — не ложное срабатывание',
    source: `fn показать() { print(ЛИМИТ) }
const ЛИМИТ = 10
показать()`,
    expect: [],
  },

  // ---- 2. запись в const --------------------------------------------------
  {
    name: '2) запись в const — ловим',
    source: `const ЛИМИТ = 100
print(ЛИМИТ)
ЛИМИТ = 5`,
    expect: [{ severity: 'error', line: 3, col: 1, match: '«ЛИМИТ» объявлено через const — менять нельзя' }],
  },
  {
    name: '2) присваивание необъявленному — ловим',
    source: `итого = 5`,
    expect: [{ severity: 'error', line: 1, col: 1, match: 'нельзя присвоить необъявленному «итого»' }],
  },
  {
    name: '2) обычный let меняется свободно — не ложное срабатывание',
    source: `let счёт = 0
счёт += 1
счёт = счёт * 2
print(счёт)`,
    expect: [],
  },

  // ---- 3. повторное объявление -------------------------------------------
  {
    name: '3) два объявления в одной области — ловим',
    source: `let a = 1
print(a)
let a = 2
print(a)`,
    expect: [{ severity: 'error', line: 3, col: 1, match: '«a» уже объявлено в этой области видимости' }],
  },
  {
    name: '3) затенение во вложенном блоке — не ложное срабатывание',
    source: `let a = 1
{
  let a = 2
  print(a)
}
print(a)`,
    expect: [],
  },

  // ---- 4. break/continue/return не на месте -------------------------------
  {
    name: '4) break в функции и return снаружи — ловим',
    source: `fn f() { break }
return 1`,
    expect: [
      { severity: 'error', line: 1, col: 10, match: '«break» вне цикла' },
      { severity: 'error', line: 2, col: 1, match: '«return» вне функции' },
    ],
  },
  {
    name: '4) break/continue/return на своих местах — не ложное срабатывание',
    source: `fn поиск(xs) {
  for x in xs {
    if x == 1 { continue }
    if x == 2 { break }
    return x
  }
  return 0
}
print(поиск([3]))`,
    expect: [],
  },

  // ---- 5. недостижимый код ------------------------------------------------
  {
    name: '5) инструкция после return — ловим',
    source: `fn f() {
  return 1
  print("сюда не дойдём")
}
print(f())`,
    expect: [{ severity: 'warning', line: 3, col: 3, match: 'код после «return» никогда не выполнится' }],
  },
  {
    name: '5) return внутри if не обрывает блок — не ложное срабатывание',
    source: `fn знак(x) {
  if x > 0 { return 1 }
  if x < 0 { return -1 }
  return 0
}
print(знак(-5))`,
    expect: [],
  },

  // ---- 6. число аргументов ------------------------------------------------
  {
    name: '6) мало и много аргументов — ловим',
    source: `fn площадь(ш, в = ш) { return ш * в }
print(площадь())
print(площадь(1, 2, 3))`,
    expect: [
      { severity: 'error', line: 2, col: 14, match: '«площадь» ожидает от 1 до 2 аргументов, а получает 0' },
      { severity: 'error', line: 3, col: 14, match: '«площадь» ожидает от 1 до 2 аргументов, а получает 3' },
    ],
  },
  {
    name: '6) конструктор структуры тоже под проверкой — ловим',
    source: `struct Точка { x = 0, y = 0 }
print(Точка(1, 2, 3))`,
    expect: [{ severity: 'error', line: 2, col: 12, match: '«Точка» ожидает от 0 до 2 аргументов, а получает 3' }],
  },
  {
    name: '6) значения по умолчанию и функция в переменной — не ложное срабатывание',
    source: `fn приветствие(имя, знак = "!") { return "Привет, \${имя}\${знак}" }
print(приветствие("Ali"))
print(приветствие("Ali", "?"))
let привет = приветствие
print(привет("Ali", "?", "лишнее"))`,
    expect: [],
  },

  // ---- 7. неизвестное поле структуры --------------------------------------
  {
    name: '7) запись в несуществующее поле — ловим',
    source: `struct Студент {
  имя
  оплачено = 0
}
let s = Студент("Ali")
s.аплачено = 500
print(s.имя)`,
    expect: [{ severity: 'error', line: 6, col: 2, match: 'у Студент нет поля «аплачено» — возможно, имелось в виду «оплачено»' }],
  },
  {
    name: '7) опечатка в поле self внутри метода — ловим',
    source: `struct Счёт {
  сумма = 0
  fn пополнить(x) { self.сума = self.сумма + x }
}
let c = Счёт(1)
c.пополнить(5)`,
    expect: [{ severity: 'error', line: 3, col: 25, match: 'у Счёт нет поля «сума» — возможно, имелось в виду «сумма»' }],
  },
  {
    name: '7) словарь и неизвестный тип — не ложное срабатывание',
    source: `struct Точка { x = 0, y = 0 }
fn сделать() { return Точка(1, 2) }
let p = Точка(1, 2)
p.x = 5
let m = { a: 1 }
m.b = 2
let q = сделать()
q.что_угодно = 1
print(p.x, m.b, q.x)`,
    expect: [],
  },

  // ---- 8. неиспользуемая переменная ---------------------------------------
  {
    name: '8) объявили и забыли — ловим',
    source: `fn f() {
  let черновик = 1
  return 2
}
print(f())`,
    expect: [{ severity: 'warning', line: 2, col: 3, match: 'переменная «черновик» объявлена, но нигде не используется' }],
  },
  {
    name: '8) переменная цикла без применения — ловим',
    source: `for i in 0..3 { print("тик") }`,
    expect: [{ severity: 'warning', line: 1, col: 1, match: 'переменная цикла «i» объявлена, но нигде не используется' }],
  },
  {
    name: '8) имена с «_», параметры и использование внутри функции — не ложное срабатывание',
    source: `const БАЗА = 2
fn f(_неважно) {
  let _черновик = 1
  let x = 2
  return x * БАЗА
}
for _ in 0..2 { print(f(0)) }`,
    expect: [],
  },
];

// ---- прогон ---------------------------------------------------------------

const show = (d: Diagnostic): string => `${d.severity} ${d.span.line}:${d.span.col} ${d.message}`;
const showExpect = (e: Expect): string => `${e.severity} ${e.line}:${e.col} ...${e.match}...`;

function numbered(source: string): string {
  return source.split('\n').map((l, i) => `      ${String(i + 1).padStart(2)} | ${l}`).join('\n');
}

function mismatch(expect: Expect[], got: Diagnostic[]): boolean {
  if (expect.length !== got.length) return true;
  return expect.some((e, i) => {
    const d = got[i]!;
    return d.severity !== e.severity || d.span.line !== e.line || d.span.col !== e.col || !d.message.includes(e.match);
  });
}

let passed = 0;
const failures: string[] = [];

for (const c of CASES) {
  let got: Diagnostic[];
  try {
    got = check(parse(tokenize(c.source, 'проверка.sable'), 'проверка.sable'), GLOBALS);
  } catch (e) {
    failures.push(`${c.name}\n    программа не разобралась: ${(e as Error).message}\n${numbered(c.source)}`);
    process.stdout.write(`  ✗ ${c.name}\n`);
    continue;
  }

  if (!mismatch(c.expect, got)) {
    passed++;
    process.stdout.write(`  ✓ ${c.name}\n`);
    continue;
  }

  process.stdout.write(`  ✗ ${c.name}\n`);
  failures.push(
    `${c.name}\n${numbered(c.source)}\n` +
    `    ожидалось (${c.expect.length}):\n` +
    (c.expect.length ? c.expect.map((e) => `      ${showExpect(e)}`).join('\n') : '      <ничего>') + '\n' +
    `    получено (${got.length}):\n` +
    (got.length ? got.map((d) => `      ${show(d)}`).join('\n') : '      <ничего>'),
  );
}

process.stdout.write(`\n${passed}/${CASES.length} прошло\n`);
if (failures.length) {
  process.stdout.write('\n' + failures.join('\n\n') + '\n');
  process.exitCode = 1;
}
