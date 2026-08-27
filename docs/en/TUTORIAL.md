# Sable — the tutorial

This text is for people who already program but are seeing Sable for the first
time. It is not a list of features — that is what the
[reference](LANGUAGE.md) is for. Instead we walk a path: from `print("Hello")`
to a finished program that parses a worklog and prints a report. Each step
solves one problem and introduces exactly what that problem needs.

> The interpreter's diagnostics are printed in Russian. The error messages below
> are quoted exactly as they appear on screen, with an English rendering
> alongside.

Every example below is a whole program. You can copy it into a file, run it,
and get precisely the output printed underneath.

## Contents

1. [How to run it](#1-how-to-run-it)
2. [Numbers and variables: how much got done](#2-numbers-and-variables-how-much-got-done)
3. [Branching: is the plan met](#3-branching-is-the-plan-met)
4. [Lists and loops: a queue of tasks](#4-lists-and-loops-a-queue-of-tasks)
5. [Functions: giving an action a name](#5-functions-giving-an-action-a-name)
6. [Maps: hours totalled per project](#6-maps-hours-totalled-per-project)
7. [Structs: when there are too many fields](#7-structs-when-there-are-too-many-fields)
8. [Strings: parsing the input](#8-strings-parsing-the-input)
9. [Closures: a function that remembers](#9-closures-a-function-that-remembers)
10. [Errors: how to fail legibly](#10-errors-how-to-fail-legibly)
11. [Putting it together: a worklog report](#11-putting-it-together-a-worklog-report)
12. [Where to go next](#12-where-to-go-next)

---

## 1. How to run it

Node 22.18 or newer is required: from that version on, TypeScript is executed
natively and there is nothing to build. On earlier versions of Node it will not
start — those need a flag for it. Save the program into a file `demo.sable` and
run it from the root of the repository:

```bash
node src/cli.ts demo.sable
```

Two more ways are useful right away: a single line of code with no file, and the
interactive session, where the value of the last expression prints itself.

```bash
$ node src/cli.ts -e 'print("two to the tenth = ${2 ^ 10}")'
two to the tenth = 1024
```

```console
$ node src/cli.ts
Sable 0.2.0 — введите выражение, «:помощь» для справки, Ctrl+D для выхода
sable> let hours = [1.5, 2, 0.75]
sable> hours.reduce((a, b) -> a + b, 0)
4.25
sable> :выход
```

The banner says: *Sable 0.2.0 — type an expression, `:помощь` for help, Ctrl+D
to leave*. The two commands keep their Russian names: `:помощь` is help,
`:выход` is quit.

The first program:

```sable
// Comments are as in C. Semicolons are not needed: a line is the end of a statement.
let who = "world"
print("Hello, ${who}!")

// ${...} is not variable substitution but any expression
print("2 + 2 = ${2 + 2}, and ${"quiet".upper()} counts too")
```

```text
Hello, world!
2 + 2 = 4, and QUIET counts too
```

Inside `${…}` you can write anything at all, including strings with the very
same quotes — the parsing follows the braces, not the quotes. This is the main
way to glue text together in Sable; for the rest, see
[Strings](LANGUAGE.md#strings).

---

## 2. Numbers and variables: how much got done

The problem: count how many hours went into the day's tasks and what that came
to in money.

```sable
const RATE = 60_000        // som per hour; a const cannot change, which guards against typos
let hours = 1.5 + 2 + 0.75

let money = hours * RATE
money -= 10_000            // minus what the taxi cost

print("Hours today: ${hours}")
print("Earned: ${money} som")
print("Average per task: ${round(hours / 3, 2)} h")
print("Thousands of som: ${int(money / 1000)}")
```

```text
Hours today: 4.25
Earned: 245000 som
Average per task: 1.42 h
Thousands of som: 245
```

There is only one number type in Sable, floating point, as in JavaScript. There
is no separate integer type, so "wholeness" is asked for explicitly: `int()`
drops the fractional part, `round(x, digits)` rounds. The underscores in
`60_000` are purely for the eye.

One thing surprises everyone coming from JavaScript or Python:

```sable
let money = 245000
print("Earned: " + money)
```

```text
Ошибка выполнения: нельзя сложить string и number — приведите к строке через str(...) или вставку ${...}
  --> demo.sable:2:18
  |
2 | print("Earned: " + money)
  |                  ^
```

*Runtime error: string and number cannot be added — convert to a string with
`str(...)` or an interpolation `${...}`.*

`+` does not mix types. This is deliberate: silently gluing a string to a number
is the source of bugs that only surface in production. Write `"${money}"` or
`str(money)`.

---

## 3. Branching: is the plan met

The problem: compare the hours worked against the plan and put a label on the
result.

```sable
let hours = 4.25
const PLAN = 6

// The condition needs no parentheses, the body is always in curly braces.
if hours >= PLAN {
  print("plan met")
} else if hours >= PLAN / 2 {
  print("more than half")
} else {
  print("the day is nearly lost")
}

// The ternary operator is an expression, so it can go into a variable
let badge = hours >= PLAN ? "✓" : "…"
print("${badge} ${hours} of ${PLAN}")

// Only false and nil are falsy. An empty string and zero are truthy!
let note = ""
print(note ? "there is a note" : "there is no note")
print(note.len() > 0 ? "there is a note" : "there is no note")

// ?? substitutes a fallback for nil — and only for nil
let grade = nil
print("grade: ${grade ?? "not given"}")
```

```text
more than half
… 4.25 of 6
there is a note
there is no note
grade: not given
```

Look at the third and fourth lines of the output: `""` is truthy, and that is on
purpose. "Empty means false" is the rule that keeps dropping `0` and `""` into
the wrong branch; here exactly two values are falsy: `false` and `nil`.

---

## 4. Lists and loops: a queue of tasks

The problem: keep a list of things to do, add to it, walk it and put it in
order.

```sable
let tasks = ["payment form", "call", "report"]
tasks.push("migration")

print("Total: ${tasks.len()}")
print("First: ${tasks.first()}, last: ${tasks[-1]}")

// A loop over a range, when the number matters. The end is excluded.
for i in 0..tasks.len() {
  print("  ${i + 1}. ${tasks[i]}")
}

// A loop over values, when the number does not matter
for t in tasks {
  if t.len() <= 6 { continue }
  print("long: ${t}")
}

// sort() and slice() return a NEW list, push() changes the existing one
print(tasks.sort().join(" · "))
print(tasks.slice(0, 2), tasks.contains("call"))
```

```text
Total: 4
First: payment form, last: migration
  1. payment form
  2. call
  3. report
  4. migration
long: payment form
long: migration
call · migration · payment form · report
["payment form", "call"] true
```

A negative index counts from the end: `tasks[-1]` is the last one. Going past
the edge, though, is an error rather than `nil`: the language would rather fall
over at the place where the mistake was made than ten lines later on a
mysterious `nil`.

The full list of methods is in [Lists](LANGUAGE.md#lists). The division worth
remembering: `push`/`pop`/`insert`/`remove_at` change the list in place,
everything else returns a new one.

---

## 5. Functions: giving an action a name

The problem: render hours in a human form and add up the totals.

```sable
// A default value is computed at the call and can see the earlier parameters
fn hours_text(hours, unit = "h") {
  return hours == int(hours) ? "${int(hours)} ${unit}" : "${hours} ${unit}"
}

fn total(numbers) { return numbers.reduce((a, b) -> a + b, 0) }

let spent = [1.5, 2, 0.75, 3]

print(spent.map(x -> hours_text(x)).join(", "))
print("altogether ${hours_text(total(spent))}")
print("longer than an hour: ${spent.filter(x -> x > 1).len()} of ${spent.len()}")
print("the longest: ${hours_text(max(spent))}")

// A function is an ordinary value: put it in a variable and pass it on
let to_minutes = x -> round(x * 60)
print(spent.map(to_minutes))
```

```text
1.5 h, 2 h, 0.75 h, 3 h
altogether 7.25 h
longer than an hour: 3 of 4
the longest: 3 h
[90, 120, 45, 180]
```

A function value can be written three ways, and all three mean the same thing:

```sable
let a = fn(x) { return x * x }   // the full form
let b = fn(x) -> x * x           // an expression body
let c = x -> x * x               // one parameter — no parentheses needed
let d = (x, y) -> x * y          // several parameters

print(a(5), b(5), c(5), d(2, 3))
```

```text
25 25 25 6
```

The arrow `->` takes an **expression**, not a block. If you need a block with
several statements, write `fn(x) { … }`.

---

## 6. Maps: hours totalled per project

The problem: turn a flat worklog into "project → hours" and find where most of
the time went.

```sable
let worklog = [
  { project: "site",  hours: 1.5 },
  { project: "crm",   hours: 2 },
  { project: "site",  hours: 0.75 },
  { project: "study", hours: 3 },
  { project: "crm",   hours: 1 },
]

// get(key, fallback) is the main move when accumulating: no need to create the
// key up front, it is enough to say what it is worth while it is still missing.
let by_project = {}
for entry in worklog {
  by_project.set(entry.project, by_project.get(entry.project, 0) + entry.hours)
}

print(by_project)

// Walking a map gives the keys; the order is insertion order, not a random one
for project in by_project {
  print("  ${project.pad_end(8, '.')} ${by_project.get(project)} h")
}

// entries() turns a map into a list of pairs — and that can be sorted
let top = by_project.entries().sort((a, b) -> b[1] - a[1]).first()
print("the biggest: ${top[0]} (${top[1]} h)")
```

```text
{"site": 2.25, "crm": 3, "study": 3}
  site.... 2.25 h
  crm..... 3 h
  study... 3 h
the biggest: crm (3 h)
```

Two things people trip over:

- `map["no such key"]` is an error. If the key may be missing, call
  `get(key, fallback)`.
- A map in the header of an `if`/`for`/`while` has to be put in parentheses, or
  the `{` reads as the start of the body: `for k in ({ a: 1 }) { … }`.

---

## 7. Structs: when there are too many fields

Maps are fine while the data is heterogeneous. As soon as every record has the
same set of fields and operations start appearing over them, it is time for a
struct.

```sable
struct Task {
  description
  project = "misc"          // a field may have a default value
  hours = 0
  done = false

  fn badge() { return self.done ? "✓" : "·" }
  fn line() { return "${self.badge()} ${self.description.pad_end(22, ' ')} ${self.project} · ${self.hours} h" }

  // A method may change fields; returning self lets the calls chain
  fn spend(amount) { self.hours += amount; return self }
  fn close() { self.done = true; return self }
}

let t = Task("fix the payment form", "site")
print(t.line())

t.spend(1.5).spend(0.25).close()
print(t.line())

print(type(t), Task("something else").project)

// Two structs are equal when all their fields are equal
print(Task("a", "x") == Task("a", "x"))
```

```text
· fix the payment form   site · 0 h
✓ fix the payment form   site · 1.75 h
Task misc
true
```

A default value is computed **on every instance creation**, so `hours = 0` and
even `history = []` are safe: there is no way to end up with one list shared by
everybody.

Assigning to a field that does not exist is an error, not the creation of a new
field. That catches typos like `t.finished = true`.

---

## 8. Strings: parsing the input

The problem: turn a line of the worklog into a structure. Data arrives as text,
and this is the most common work in a program's life.

```sable
const LINE = "2026-08-21 | done | site | A | fix the payment form | 1.5"

fn parse(line) {
  // split gives a list; map/trim strip the spaces around each part
  let parts = line.split("|").map(c -> c.trim())
  return {
    date: parts[0],
    done: parts[1] == "done",
    project: parts[2],
    importance: parts[3],
    description: parts[4],
    // num(string, fallback) does not fail on junk, it returns the fallback
    hours: num(parts[5], 0),
  }
}

let w = parse(LINE)
print(w.project, w.hours, w.done)

// Columns are lined up with pad_end/pad_start, repetition is multiplication
print("-" * 44)
print("${w.date}  ${w.description.pad_end(26, '.')} ${str(w.hours).pad_start(5, ' ')} h")
print("-" * 44)

// Strings are immutable: every "changing" method returns a new string
let word = "  Résumé  "
print("[${word.trim().lower()}] length ${word.trim().len()}")
print("day: ${w.date.slice(8)}, month: ${w.date.slice(5, 7)}")
```

```text
site 1.5 true
--------------------------------------------
2026-08-21  fix the payment form......   1.5 h
--------------------------------------------
[résumé] length 6
day: 21, month: 08
```

Length and indexes are counted in characters, not bytes, so accented letters cut
without surprises: `"Résumé".len()` is 6, not 8.

---

## 9. Closures: a function that remembers

The problem: collect statistics as you go, and learn to build filters on the
fly.

```sable
// A function returning a function: the filter is built for one project
fn of_project(name) { return w -> w.project == name }

// A closure remembers its environment: sum lives on between the calls, and
// there is no way to reach it from outside except the returned functions.
fn accumulator() {
  let sum = 0
  let seen = 0
  return {
    add: fn(x) { sum += x; seen += 1; return sum },
    average: () -> seen == 0 ? 0 : round(sum / seen, 2),
    total: () -> sum,
  }
}

let worklog = [
  { project: "site", hours: 1.5 },
  { project: "crm",  hours: 2 },
  { project: "site", hours: 0.75 },
]

print("entries for site: ${worklog.filter(of_project("site")).len()}")

let acc = accumulator()
for w in worklog { acc.add(w.hours) }
print("altogether ${acc.total()} h, on average ${acc.average()} h")

// Every iteration of a for loop gets ITS OWN loop variable
let deferred = []
for i in 0..3 { deferred.push(() -> i * 10) }
print(deferred.map(f -> f()))
```

```text
entries for site: 2
altogether 4.25 h, on average 1.42 h
[0, 10, 20]
```

The last example is worth remembering: in languages where the loop variable is
one for all iterations, `[0, 10, 20]` turns into `[20, 20, 20]`. Not here.

---

## 10. Errors: how to fail legibly

The problem: refuse to book more hours into a day than the day has.

```sable
fn spend(left, hours) {
  assert(hours > 0, "hours must be positive, got ${hours}")
  if hours > left {
    error("need ${hours} h, but only ${left} left in the day")
  }
  return left - hours
}

let day = 8
day = spend(day, 3)
day = spend(day, 2)
print("${day} h left")

day = spend(day, 5)
print("we never get here")
```

```text
3 h left
Ошибка выполнения: need 5 h, but only 3 left in the day
  --> demo.sable:4:10
  |
4 |     error("need ${hours} h, but only ${left} left in the day")
  |          ^
  в spend (demo.sable:14:12)
```

*Runtime error: need 5 h, but only 3 left in the day*, then the file, line and
column, the source line with a caret under the culprit, and the call stack
(`в` = "in").

The error shows what happened, where exactly, and through which calls it got
there. `assert(condition, message)` is for what must never happen;
`error(value)` is for a refusal on the merits.

An error stops the program. So for **expected** failures — "not found", "could
not parse" — it is more convenient to return `nil` and deal with it on the spot:

```sable
let worklog = [{ project: "site", hours: 1.5 }, { project: "crm", hours: 2 }]

fn project_hours(worklog, name) {
  let found = worklog.find(w -> w.project == name)
  return found == nil ? nil : found.hours
}

print("site: ${project_hours(worklog, "site") ?? "no entries"}")
print("depot: ${project_hours(worklog, "depot") ?? "no entries"}")
```

```text
site: 1.5
depot: no entries
```

Which error-handling facilities your version actually has is in the
[Errors](LANGUAGE.md#errors) section of the reference.

---

## 11. Putting it together: a worklog report

Now let us put it all together. The program reads a worklog in textual form,
turns it into structs, checks the data and prints a report: a summary by day, a
breakdown by project with a histogram, and a list of what is left.

```sable
// ---- data -----------------------------------------------------------------
// date | status | project | importance | description | hours

const WORKLOG = `
2026-08-17 | done | site  | A | fix the payment form      | 2.5
2026-08-17 | done | crm   | B | call with the client      | 1
2026-08-18 | done | site  | C | captions for the pictures | 0.5
2026-08-18 | open | crm   | A | database migration        | 4
2026-08-18 | done | study | B | the chapter on closures   | 1.5
2026-08-19 | done | crm   | A | database migration        | 3
2026-08-19 | open | site  | B | layout review             | 1
2026-08-20 | done | study | C | lecture notes             | 0.75
2026-08-20 | open | crm   | A | incident report           | 2
`

const IMPORTANCE = { A: "urgent", B: "normal", C: "later" }

// ---- model ----------------------------------------------------------------

struct Work {
  date
  done
  project
  importance
  description
  hours

  fn badge() { return self.done ? "✓" : "·" }
  fn line() {
    return "${self.badge()} ${self.description.pad_end(28, ' ')} ${self.project.pad_end(7, ' ')} ${str(self.hours).pad_start(4, ' ')} h"
  }
}

fn parse(line) {
  let c = line.split("|").map(x -> x.trim())
  assert(c.len() == 6, "line '${line}' has ${c.len()} columns instead of 6")
  assert(IMPORTANCE.has(c[3]), "unknown importance '${c[3]}' in line '${line}'")
  return Work(c[0], c[1] == "done", c[2], c[3], c[4], num(c[5], 0))
}

let works = WORKLOG.trim().split("\n").map(s -> parse(s))

// ---- tools ----------------------------------------------------------------

fn group_by(list, key) {
  let groups = {}
  for x in list {
    let k = key(x)
    let bucket = groups.get(k, [])
    bucket.push(x)
    groups.set(k, bucket)
  }
  return groups
}

fn hours_of(list) { return list.map(w -> w.hours).reduce((a, b) -> a + b, 0) }
fn bar(part, whole, width) { return "▮" * int(round(part / whole * width)) }

// ---- report ---------------------------------------------------------------

let total = hours_of(works)
let closed = works.filter(w -> w.done)
let days = group_by(works, w -> w.date)

print("Worklog: ${works.len()} entries over ${days.len()} days, ${total} h")
print("Closed: ${closed.len()} (${round(hours_of(closed) / total * 100)}% of the time)")

print("\nBy day")
for day in days.keys().sort() {
  let of_day = days.get(day)
  let open = of_day.filter(w -> !w.done).len()
  let tail = open == 0 ? "all closed" : "${open} in progress"
  print("  ${day}  ${str(hours_of(of_day)).pad_start(5, ' ')} h  ${tail}")
}

print("\nBy project")
let projects = group_by(works, w -> w.project)
for pair in projects.entries().sort((a, b) -> hours_of(b[1]) - hours_of(a[1])) {
  let name = pair[0]
  let hours = hours_of(pair[1])
  print("  ${name.pad_end(7, ' ')} ${str(hours).pad_start(5, ' ')} h ${bar(hours, total, 24)}")
}

print("\nStill to do")
let open = works.filter(w -> !w.done).sort((a, b) -> a.importance < b.importance ? -1 : a.importance > b.importance ? 1 : 0)
for w in open {
  print("  ${w.line()}  ${IMPORTANCE.get(w.importance)}")
}

// The same task may drag on for several days — find the longest one
let by_description = group_by(works, w -> w.description)
let longest = by_description.entries().sort((a, b) -> hours_of(b[1]) - hours_of(a[1])).first()
print("\nLongest of all: '${longest[0]}' — ${hours_of(longest[1])} h over ${longest[1].len()} days")
```

```text
Worklog: 9 entries over 4 days, 16.25 h
Closed: 6 (57% of the time)

By day
  2026-08-17    3.5 h  all closed
  2026-08-18      6 h  1 in progress
  2026-08-19      4 h  1 in progress
  2026-08-20   2.75 h  1 in progress

By project
  crm        10 h ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮
  site        4 h ▮▮▮▮▮▮
  study    2.25 h ▮▮▮

Still to do
  · database migration           crm        4 h  urgent
  · incident report              crm        2 h  urgent
  · layout review                site       1 h  normal

Longest of all: 'database migration' — 7 h over 2 days
```

There is nothing here that was not in chapters 2–10: strings, lists, maps,
structs, function values and an `assert` on the way in. Note two habits that pay
off in any program of this kind. First: the checks sit in `parse`, that is, on
the boundary where text turns into data — from there on the code may assume the
fields are in place. Second: `group_by`, `hours_of` and `bar` are written once
and reused three times each; that, and not the length of the file, is what
separates a report you are not afraid to change.

---

## 12. Where to go next

What to read next, in order of usefulness:

- [LANGUAGE.md](LANGUAGE.md) — the reference: everything the language has, with
  exact wording on operator precedence, scope, and the behaviour of every
  method.
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the interpreter itself is built:
  lexer, parser, compilation of the tree into closures.

The examples in `examples/` are not toys but solved problems; they are best read
in ascending order of number:

| File | About |
|---|---|
| `01_hello.sable` | functions and output |
| `02_fizzbuzz.sable` | loops and conditions |
| `03_wordcount.sable` | word frequency: strings and maps |
| `04_shapes.sable` | structs with methods |
| `05_closures.sable` | closures, counting and memoisation |
| `06_json_report.sable` | parsing JSON and a report |
| `07_csv_sales.sable` | CSV, grouping, three cuts of the same data |
| `08_calculator.sable` | a lexer, recursive descent, an expression tree |
| `09_state_machine.sable` | a state machine on a transition table |
| `10_graphs.sable` | Dijkstra and a topological sort |
| `11_sorting.sable` | three sorts, binary search, comparators |
| `12_search_index.sable` | an inverted index and full-text search |

They run the same way: `node src/cli.ts examples/08_calculator.sable`.

The output of the examples is locked by tests: `node tests/run.ts` compares it
against the references in `tests/examples/`. If you change something in the
language, the examples break first — which is exactly what they are for.
