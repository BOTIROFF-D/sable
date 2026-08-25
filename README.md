# Sable

**English** · [Русский](#о-языке)

A general-purpose programming language whose interpreter compiles the AST to
closures. Written in TypeScript, runs on Node with no build step and zero runtime
dependencies — `node src/cli.ts file.sable` is the whole toolchain.

```sable
fn fib(n) { if n < 2 { return n }; return fib(n - 1) + fib(n - 2) }
print(fib(20))
```

```text
6765
```

- **Nothing to install.** Node executes the TypeScript sources natively; `tsc` is
  used for type checking only, and the runtime pulls in no packages at all.
- **Diagnostics meant to be read.** Every error carries a position, the source line
  with a caret under the culprit, a call stack, and a suggestion when a name looks
  like a typo. All syntax errors are reported in a single pass.
- **Tooling in the box.** A formatter (`sable fmt`), a static checker that runs
  without executing the program (`sable --check`), a VS Code syntax grammar, and
  two fuzzers that shrink any failure they find down to a few lines.
- **440 checks in five independent suites** — including the exact text of every
  error message, every example program, and every code block in the documentation.
  A full rewrite of the interpreter core passed them without touching a single
  expected output.

```bash
node src/cli.ts examples/01_hello.sable   # run a file
node src/cli.ts                           # interactive session
node src/cli.ts --check file.sable        # analyse without running
npm test                                  # all five suites
```

> The reference, the tutorial and all diagnostics are written in Russian.
> Start at [docs/TUTORIAL.md](docs/TUTORIAL.md), the full reference is
> [docs/LANGUAGE.md](docs/LANGUAGE.md), the internals are in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## О языке

Язык программирования общего назначения: лексер → парсер → AST → компиляция в замыкания.
Написан на TypeScript, работает на Node без сборки и без единой зависимости в рантайме.

```sable
struct Point {
  x = 0
  y = 0
  fn len() { return sqrt(self.x ^ 2 + self.y ^ 2) }
}

let points = [Point(3, 4), Point(1, 1)]
let longest = points.sort((a, b) -> b.len() - a.len()).first()

print("Самая длинная: ${longest.x}, ${longest.y} → ${round(longest.len(), 2)}")
```

## Запуск

Требуется Node 22.6+ (TypeScript исполняется нативно, компиляция не нужна).

```bash
node src/cli.ts examples/01_hello.sable   # выполнить файл
node src/cli.ts                         # интерактивный режим: Tab, история, :помощь
node src/cli.ts -e 'print(2 ^ 10)'      # выполнить строку
node src/cli.ts --check файл.sable       # проверить, не запуская
node src/cli.ts fmt -w файл.sable        # привести к каноническому виду
node bench/run.ts                       # замеры производительности
npm test                                # прогнать все тесты
```

Чтобы вызывать просто `sable`:

```bash
npm link          # или: ln -s "$PWD/bin/sable.mjs" /usr/local/bin/nur
sable examples/04_shapes.sable
```

## Что уже умеет язык

| | |
|---|---|
| Типы | `number`, `string`, `bool`, `nil`, `list`, `map`, `range`, `fn`, структуры |
| Переменные | `let` (изменяемая), `const` (нет) |
| Функции | значения по умолчанию, замыкания, первый класс, рекурсия, лямбды `x -> x * 2` |
| Структуры | поля со значениями по умолчанию, методы, `self` |
| Управление | `if`/`else if`/`else`, `while`, `for … in`, `break`, `continue`, тернарный `? :` |
| Ошибки как значения | `try`/`catch`, свой бросок через `error(…)`, `assert` |
| Модули | `import "lib/math.sable" as math` — файл выполняется один раз, циклы ловятся |
| Строки | вставки `${…}`, многострочные в \`обратных кавычках\`, ~15 методов |
| Коллекции | `map`/`filter`/`reduce`/`sort`/`find`, срезы, отрицательные индексы |
| Диагностика | позиция в исходнике, стрелка под виновником, стек вызовов, подсказки по опечаткам, все синтаксические ошибки за один проход |
| Прочее | JSON, файлы, ввод с клавиатуры |

Пошаговое введение — [docs/TUTORIAL.md](docs/TUTORIAL.md).
Полный справочник — [docs/LANGUAGE.md](docs/LANGUAGE.md).
Как устроен интерпретатор — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Ошибки, на которые не стыдно смотреть

```
$ sable pay.sable
Ошибка выполнения: имя «blance» не определено — возможно, имелось в виду «balance»
  --> pay.sable:7:22
  |
7 |   let remaining = blance - amount
  |                   ^
  в withdraw (pay.sable:12:16)
  в main (pay.sable:18:5)
```

Каждая ошибка знает: что произошло, где именно, и через какие вызовы туда пришли.
Повторяющиеся кадры рекурсии схлопываются в `× N`.

## Устройство

```
src/
  lexer.ts        текст          → лексемы
  parser.ts       лексемы        → AST          (рекурсивный спуск)
  interpreter.ts  AST            → замыкания    (компиляция и выполнение)
  checker.ts      AST            → замечания    (проверка без запуска)
  modules.ts      загрузка import: кэш, циклы, пути
  values.ts       значения времени выполнения, равенство, печать
  environment.ts  области видимости и поиск имён
  stdlib.ts       встроенные функции и методы типов
  format.ts       AST            → канонический текст (sable fmt)
  errors.ts       единый формат ошибок со стрелкой
  cli.ts          запуск файла, REPL, -e, --check, fmt
tests/            golden-тесты: вывод программы сверяется с эталоном
examples/         примеры (их вывод тоже под замком тестов)
docs/             учебник, справочник, устройство
```

## Тесты

```bash
npm test                       # проверить всё: язык, анализатор, документацию
node tests/run.ts --only=maps  # только словари
node tests/run.ts --update     # перезаписать эталоны (после осознанной правки)
```

Три независимых набора:

| Набор | Что запирает |
|---|---|
| `tests/run.ts` | вывод программ и **текст каждой ошибки**, плюс вывод всех примеров |
| `tests/checker.ts` | статический анализ: каждая проверка «ловит» и «не ложно срабатывает» |
| `tests/docs.ts` | код из документации выполняется, вывод сверяется с напечатанным |
| `tests/grammar.ts` | подсветка знает те же слова, что и язык |
| `tests/format.ts` | форматтер: идемпотентность, сохранение дерева, комментариев и вывода |

Отдельно живут два охотника, в `npm test` они не входят — это охота, а не проверка:

- `node tests/fuzz.ts` — случайные программы: следы JavaScript наружу, зависания,
  расхождения `--check` с выполнением, нарушения законов языка;
- `node tests/fuzz-tools.ts` — всё вокруг ядра: наборы модулей (цепочки, ромб,
  циклы импорта), форматтер как оракул (вывод до и после обязан совпасть),
  файловые функции, `input()` и интерактивный режим.

Найденный пример оба сокращают сами — из сотни строк остаётся несколько.

Отдельными кейсами покрыт каждый класс ошибки: неизвестное имя, несовпадение
типов, деление на ноль, выход за границы, запись в `const`, неверное число
аргументов, вызов не-функции, обращение к полю у `nil`, синтаксис, незакрытая
строка, глубокая рекурсия, свои ошибки, отсутствующий модуль, `try` без `catch`.

Документация с выдуманным выводом хуже отсутствующей — поэтому она под тестом,
а не под честным словом.

## Что дальше

Сделано после 0.1: модули (`import … as`), перехват ошибок (`try`/`catch`),
статическая проверка (`--check`), форматтер (`sable fmt`), расширенная библиотека,
разбор с восстановлением, подсветка для VS Code, фаззер. Скорость выросла
в 3,2 раза: сначала точечные оптимизации по профилю, затем компиляция AST
в замыкания.

Ближайшие шаги, в порядке пользы:

1. **Разрешение имён в слоты** — поиск по цепочке областей остаётся самым дорогим, что осталось.
2. **Выборочный импорт** — `import "utils.sable" as { double, area }` вместо одного пространства имён.
3. **Целочисленный тип** — сейчас всё число с плавающей точкой, как в JS.
4. **Асинхронность или потоки** — сейчас язык строго последовательный.

Известное ограничение: глубина рекурсии ~900 вызовов (упирается в стек JS).
Поднимается через `SABLE_MAX_DEPTH` вместе с `node --stack-size=...`.

## Автор

**Дониёр Ботиров** — основатель [THE BOTIROFF LLC](https://botiroff.com) (США),
компании по разработке программного обеспечения, и холдинга BOTIROFF.

Строит продукты, а не демонстрации: системы, которые каждый день работают
у живых клиентов и держат их деньги, расписания и переписку.

| Проект | Что это |
|---|---|
| [THE CRM](https://thecrm.uz) | CRM с искусственным интеллектом для учебных центров: финансы, посещаемость, зарплаты, ИИ-обзвон и боты в Telegram и Instagram |
| [ULTRATHINK](https://ultrathink.uz) | Премиальный учебный центр по искусственному интеллекту |
| [BOTIROFF SPACE](https://space.botiroff.com) | 3D-конфигуратор мебели с подбором через ИИ |
| [dbit](https://dbit.one) | Разработка на заказ |
| **Sable** | Этот язык программирования |

Образование — Высшая школа экономики и Финансовый университет при Правительстве
Российской Федерации. Сертификации Meta и Google, стажировки в Газпромбанке и
Citibank. IELTS 9.0 — высший возможный балл, SAT 1590 из 1600.

Связь: [botiroff.com](https://botiroff.com) · [t.me/mrdoniyor](https://t.me/mrdoniyor) · [github.com/BOTIROFF-D](https://github.com/BOTIROFF-D)

## Лицензия

MIT — см. [LICENSE](LICENSE). Copyright © 2026 Doniyor Botirov.
