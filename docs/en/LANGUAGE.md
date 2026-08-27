# Sable — language reference

Version 0.2.0. Everything described below works and is covered by tests.

> Diagnostics are printed in Russian. Error messages quoted in this document are
> shown exactly as the interpreter prints them, with a translation alongside.

## Contents

- [Syntax at a glance](#syntax-at-a-glance)
- [Types and literals](#types-and-literals)
- [Variables](#variables)
- [Operators](#operators)
- [Strings](#strings)
- [Lists](#lists)
- [Maps](#maps)
- [Ranges](#ranges)
- [Control flow](#control-flow)
- [Functions](#functions)
- [Structs](#structs)
- [Modules](#modules)
- [Errors](#errors)
- [Standard library](#standard-library)

## Syntax at a glance

A statement ends at a newline; a semicolon is only needed to put two statements
on one line.

```sable
let a = 1
let b = 2; let c = 3
```

Line breaks inside `(…)` and `[…]` carry no meaning — a long call can be spread
over several lines. An expression cut off by an operator also continues:

```sable
let total = price *
            quantity
```

Comments: `// to end of line` and `/* block, /* nested */ too */`.

The bodies of `if`, `while`, `for`, functions and structs are always in curly
braces. The condition needs no parentheses.

## Types and literals

| Type | Example | Notes |
|---|---|---|
| `number` | `42`, `-7`, `3.5`, `1_000_000`, `0xFF`, `1e3` | a single floating-point number, as in JS |
| `string` | `"text"`, `'text'`, `` `many\nlines` `` | immutable, indexed by characters |
| `bool` | `true`, `false` | |
| `nil` | `nil` | absence of a value |
| `list` | `[1, "two", nil]` | mutable, any mix of values |
| `map` | `{ name: "Ali", age: 20 }` | insertion order is preserved |
| `range` | `0..10` | lazy, the end is excluded |
| `fn` | `fn(x) { … }`, `x -> x * 2` | a first-class value |
| struct | `Point(3, 4)` | see [Structs](#structs) |

To check a type: `type(v)` returns a string (`"number"`, `"list"`, or the struct
name).

## Variables

```sable
let counter = 0      // can be reassigned
counter += 1

const LIMIT = 100    // cannot — assigning to it is an error
```

Names may use Latin or Cyrillic letters; the Turkic okina is allowed inside a
name (`oʻquvchi`, `gʻalaba`). A plain apostrophe is not part of a name — it is
taken by string literals. Scope is the block. An inner block may shadow an outer
name, but the same name cannot be declared twice in one block.

## Operators

By binding strength, from tightest to loosest:

Compound assignment (`+=`, `-=`, `*=`, `/=`) evaluates the target **once**: in
`xs[index()] += 5` the function `index()` is called a single time. This is not
shorthand for `xs[index()] = xs[index()] + 5` but a different, more predictable
operation.

| Level | Operators |
|---|---|
| postfix | `f(…)` `a[i]` `a.b` |
| power | `^` (right-associative: `2^3^2` = `2^9`) |
| unary | `-x` `!x` (`not x`) |
| multiplicative | `*` `/` `%` |
| additive | `+` `-` |
| range | `..` |
| comparison | `<` `<=` `>` `>=` |
| equality | `==` `!=` |
| AND | `&&` (`and`) |
| OR | `\|\|` (`or`) |
| "if nil" | `??` |
| ternary | `? :` |
| assignment | `=` `+=` `-=` `*=` `/=` |

The fine points, which usually surface later:

- `-2 ^ 2` is `-4`: the power binds tighter than unary minus, as in mathematics.
- `==` compares **by content**: `[1, [2]] == [1, [2]]` is true.
- Only `false` and `nil` are falsy. `0` and `""` are truthy.
- `&&` and `||` do not evaluate the right-hand side once the outcome is settled.
- `??` substitutes the fallback only for `nil`, never for `false` or `0`.
- Division by zero is an error, not `inf`. So is any overflow: `1e308 * 10`,
  `0 ^ -1`, `exp(1000)` are errors. The language has neither infinity nor
  "not a number", because otherwise they would spread through a program silently
  and surface in JSON as `null`.
- `+` does not mix types: `"total: " + 5` is an error, write `"total: ${5}"` or
  `str(5)`.

Useful overloads: `"ab" * 3` → `"ababab"`, `[0] * 3` → `[0, 0, 0]`,
`[1, 2] + [3]` → `[1, 2, 3]`, strings compare lexicographically.

## Strings

```sable
let name = "World"
print("Hello, ${name}! ${2 + 2} = ${"four".upper()}")
```

An interpolation `${…}` takes any expression, including nested strings.
Escapes: `\n` `\t` `\r` `\\` `\"` `\'` `` \` `` `\$` `\0` `\u{1F600}`.

A multiline string goes in backticks; inside it ordinary quotes need no
escaping, and `${…}` interpolations work the same.

Length and indexes are counted in characters, not bytes: `len("héllo")` = 5,
`"héllo"[-1]` = `"o"`.

**Methods:** `len` `upper` `lower` `trim` `chars` `reverse` `contains(s)`
`starts_with(s)` `ends_with(s)` `index_of(s)` `replace(from, to)` `split(sep?)`
`slice(from, to?)` `repeat(n)` `pad_start(n, ch?)` `pad_end(n, ch?)`

Strings are immutable: `s[0] = "a"` is an error, build a new string instead.

## Lists

```sable
let xs = [3, 1, 2]
xs.push(4)
print(xs[0], xs[-1], xs.len())
```

A negative index counts from the end. Going out of bounds is an error, not
`nil`: a silent `nil` hides typos.

**Mutate the list:** `push(…)` `pop()` `insert(i, v)` `remove_at(i)`
**Return a new one:** `sort(cmp?)` `reverse()` `slice(from, to?)` `clone()` `map(f)` `filter(f)`
**Answer a question:** `len()` `first()` `last()` `contains(v)` `index_of(v)` `find(f)` `find_index(f)` `any(f)` `all(f)` `reduce(f, initial)` `join(sep?)`

`find` returns `nil` both when nothing matched and when the match itself was `nil`.
When the difference matters, use `find_index` — it returns a position or `-1`.

```sable
let names = ["Vali", "Ali", "Gulnoz"]
print(names.sort().join(", "))
print(names.filter(n -> n.len() > 3).map(n -> n.upper()))
print(names.reduce((acc, n) -> acc + n.len(), 0))
```

```text
Ali, Gulnoz, Vali
["VALI", "GULNOZ"]
13
```

`sort()` with no argument orders numbers or strings; for anything else pass a
comparison function returning a negative number, zero or a positive number:

```sable
students.sort((a, b) -> b.paid - a.paid)
```

The callback receives `(value, index)`, but is free to take only the first
argument.

## Maps

```sable
let u = { name: "Ali", age: 20 }
print(u.name, u["age"])
u.age = 21
u["city"] = "Bukhara"
```

A key may be a string, a number or a `bool`. A computed key goes in square
brackets: `{ [variable]: 1 }`.

Dot access looks for **data** first and only then for a method — so that `u.name`
works no matter what the methods happen to be called. If a piece of data and a
method share a name, the data wins and the method becomes unreachable.

For that case there are free functions: `len(u)`, `keys(u)`, `values(u)`,
`entries(u)`, `get(u, key, fallback?)`, `set(u, key, value)`, `has(u, key)`,
`remove(u, key)`. Eight are enough to work with a dictionary whose keys came from
outside — JSON from someone else's API does contain keys named `get` and `set`.

The remaining methods (`clone`, `merge`, `pick`, `omit`, `map_values`, `filter`,
`is_empty`, `get_or_insert`) are still shadowed by a key of the same name; work
around it with `keys` and `get`.

`u["missing"]` for an absent key is an error; `u.get("missing", fallback)` is not.

**Methods:** `len()` `keys()` `values()` `entries()` `has(k)` `get(k, fallback?)`
`set(k, v)` `remove(k)` `clone()` `merge(other)`

A map in the header of `if`/`while`/`for` must be parenthesised — otherwise `{`
reads as the start of the body:

```sable
for key in ({ a: 1, b: 2 }) { print(key) }
```

```text
a
b
```

## Ranges

`start..end` — the end is excluded. A range is lazy: `0..1000000` does not
create a million elements until you call `.list()`.

```sable
for i in 0..5 { write(i, " ") }
print((1..4).list(), (0..5).len(), (0..5).contains(5))
```

```text
0  1  2  3  4  [1, 2, 3] 5 false
```

(`write` also separates its own arguments with a space, hence the double
spacing, and it adds no newline — so the `print` lands on the same line.)

Need a step or reverse order — `range(from, to, step)`: `range(10, 0, -2)`.

Range bounds must be ordinary numbers no greater than 9 007 199 254 740 991.
Beyond that limit adding one stops moving the counter and the loop would never
finish — so such a bound is an error right away, not a silent hang.

## Control flow

```sable
if x > 10 { print("many") }
else if x > 5 { print("some") }
else { print("few") }

while condition { … }

for item in sequence { … }
```

`for` walks a list, a string (by characters), a range and a map (by keys).
`break` and `continue` work in both loops.

Every iteration of `for` gets **its own** loop variable — closures created inside
will remember different values:

```sable
let fns = []
for i in 0..3 { fns.push(fn() -> i) }
print(fns.map(f -> f()))   // [0, 1, 2]
```

```text
[0, 1, 2]
```

The ternary operator is an expression, not a statement:

```sable
let label = debt > 0 ? "in debt" : "paid"
```

## Functions

```sable
fn area(width, height = width) {
  return width * height
}
```

A default value is evaluated at call time and **sees the preceding parameters**.
A parameter without a default may not follow one that has a default. A function
with no `return` returns `nil`.

Three ways to write a function value:

```sable
let a = fn(x) { return x * x }   // full form
let b = fn(x) -> x * x          // expression body
let c = x -> x * x              // single parameter
let d = (x, y) -> x * y         // several parameters
```

Functions are ordinary values: they can be passed, returned and stored. A
closure remembers the environment it was created in:

```sable
fn counter() {
  let n = 0
  return fn() { n += 1; return n }
}
let next = counter()
print(next(), next(), next())   // 1 2 3
```

```text
1 2 3
```

A function name is looked up at the moment of the call, not of the declaration,
so mutual recursion works — all that matters is that both functions are declared
before the first call.

## Structs

```sable
struct Student {
  name
  paid = 0
  fn owes() { return self.paid == 0 }
  fn with_payment(amount) { return Student(self.name, self.paid + amount) }
}

let s = Student("Ali")
print(s.owes(), s.with_payment(450000).paid)
```

```text
true 450000
```

Fields are listed in order and may have default values. An instance is created
by calling the struct name; arguments are positional. Inside methods `self` is
the current instance; fields may be changed.

Assigning to a field that does not exist is an error: this catches typos.
Two instances of the same struct are equal if all their fields are equal.
`to_json(instance)` turns it into a JSON object.

## Modules

A program can be split across files.

```sable
// lib/math.sable
const PI2 = 6.283185307179586
fn area(r) { return PI2 / 2 * r ^ 2 }
struct Vector { x, y }
```

```sable
// main.sable
import "lib/math.sable" as math

print(math.area(2))
print(math.Vector(3, 4).x)
```

The rules are short:

- The path is resolved **relative to the folder of the importing file**, not to
  where you launched the program.
- **Everything declared at the top level** of the module is exported: `let`,
  `const`, `fn`, `struct`. There is no separate keyword for it.
- A file is executed **exactly once**, however many modules import it. Printing
  and other side effects of a module do not repeat.
- `import` is allowed only at the top level of a file.
- Module names cannot be reassigned: `math.area = …` is an error.
- A circular import is detected and prints the whole chain instead of looping.

### Taking only some names

A module can be brought in whole, or only the names you need:

```sable
import "lib/math.sable" as {area, PI2}
import "lib/math.sable" as {area as circleArea}
```

The two forms coexist and can point at the same file — it is still executed once.
A name that the module does not export is an error at the import itself, with the
same closest-name suggestion. A name listed twice, or an empty list, is a syntax
error: neither has any meaning worth carrying to run time.

Reaching for something a module does not have suggests the closest name:

```text
Ошибка выполнения: в модуле «math» нет имени «are» — возможно, имелось в виду «area»
```

(“Runtime error: module «math» has no name «are» — did you mean «area»?”)

An error inside a module shows a line from **its own** file, not from the main
one.

## Errors

You raise your own error with `error(value)`; you assert with
`assert(condition, message?)`.

```sable
fn withdraw(balance, amount) {
  if amount > balance { error("insufficient funds: need ${amount}, have ${balance}") }
  return balance - amount
}
```

An uncaught error stops the program and prints the location, the source line
with a caret and the call stack.

An error can be caught:

```sable
fn withdraw(balance, amount) {
  if amount > balance { error("insufficient funds: need ${amount}, have ${balance}") }
  return balance - amount
}

try {
  print("left: ${withdraw(100, 30)}")
  print("left: ${withdraw(100, 500)}")
} catch e {
  print("failed:", e.message)
}
```

```text
left: 70
failed: insufficient funds: need 500, have 100
```

What you catch is always a map with the same keys, no matter where the error
came from:

| Key | What is inside |
|---|---|
| `message` | the error text |
| `value` | whatever was passed to `error(…)`; `nil` for built-in errors |
| `file`, `line`, `column` | where it happened |

So `e.message` always works, and `e.value` is what you need when you threw not a
string but your own data:

```sable
try { error({ code: 404, text: "not found" }) }
catch e { print(e.value.code, e.value.text, e.message) }
```

```text
404 not found {"code": 404, "text": "not found"}
```

The variable name is optional: `catch { … }`. A `try` with neither a `catch` nor
a `finally` is a syntax error, not a silently swallowed block.

Only runtime errors are caught. `return`, `break` and `continue` pass straight
through `try` — otherwise a `return` from inside a `try` would stop leaving the
function.

### finally

`finally` is what has to be done in any case: close the file, release the lock,
put the button back the way it was.

```sable
fn clean_up() { print("cleaned up") }

try {
  print("working")
  error("it broke")
} catch e {
  print("failed:", e.message)
} finally {
  clean_up()
}
```

```text
working
failed: it broke
cleaned up
```

The `catch` is optional here — a `try` with only a `finally` is legal. The error
is then not caught: the block is carried to the end and the error flies on.

```sable
fn clean_up() { print("cleaned up") }

try {
  try { error("it broke") } finally { clean_up() }
} catch e {
  print("arrived:", e.message)
}
```

```text
cleaned up
arrived: it broke
```

"Always" here is literal. `finally` runs:

- when the body reaches its end;
- when the error was caught by its own `catch`;
- when there is nobody to catch it and the error flies on;
- when the `catch` itself raised an error;
- when `try` or `catch` is left through `return`, `break` or `continue` — and it
  runs **before** the function returns its value and before the loop breaks.

```sable
fn find(xs, what) {
  for x in xs {
    try {
      if x == what { return "found ${x}" }
    } finally {
      print("looked at ${x}")
    }
  }
  return "no such thing"
}

print(find([1, 2, 3], 2))
```

```text
looked at 1
looked at 2
found 2
```

**What matters here.** A `finally` may leave the block on its own — through its
own `return`, `break`, `continue` or its own error. It then **overrides** the
reason the block was being left: the other `return`'s value never comes back,
and the other error vanishes without a trace.

```sable
fn how_many() {
  try { return "from try" } finally { return "from finally" }
}

fn swallowed() {
  try { error("this error disappears") } finally { return "from finally" }
}

print(how_many(), swallowed())
```

```text
from finally from finally
```

The language does not forbid this: an error from a function called inside
`finally` overrides the pending one in exactly the same way, and a half-ban
would only confuse. But the case is a well-known source of bugs, so
`sable --check` warns about it. The rule is simple — leave a `finally` the
ordinary way, by reaching the end of the block.

One `try` cannot have two `finally` blocks, and a `finally` without a `try` is a
syntax error.

## Standard library

**Output and input**
`print(…)` space-separated, with a newline · `write(…)` without a newline ·
`input(prompt?)` a line from stdin, `nil` at end of input ·
`read_file(path)` · `write_file(path, text)`

**Types and conversion**
`type(v)` · `str(v)` · `repr(v)` as in code · `num(v, fallback?)` · `int(v)` drops the fraction · `bool(v)` · `len(v)`

**Numbers**
`abs` `floor` `ceil` `round(n, digits?)` `sqrt` `pow(a, b)` `min(…)` `max(…)`
`sign(n)` -1, 0 or 1 · `clamp(n, lo, hi)` forces a number into bounds ·
`random()` in \[0, 1) · `random_int(from, to)` both bounds included

`round` rounds halves away from zero: `round(2.5)` = 3, `round(-2.5)` = -3.
`clamp` requires `lo <= hi` — swapped bounds are an error, not a silent flip.

**Mathematics**
`exp(n)` · `log(n, base?)` without a base it is natural ·
`hypot(a, b, …)` vector length · `sin` `cos` `tan` `asin` `acos` `atan`
`atan2(y, x)` · `pi()` the number π

`log(1000, 10)` = 3 and `log(8, 2)` = 3 exactly: base two and base ten are
computed separately, since dividing logarithms would have given
2.9999999999999996. `log(0)`, `asin(2)`, `log(n, 1)` are errors: outside the
domain.

π is a function `pi()`, not a name `PI`: a built-in name cannot be shadowed by
your own `let`/`const`, and a constant would take a common name away from the
program. If you want a constant — `const PI = pi()` at the top of the file. The
number e comes from `exp(1)`.

**Sequences**
`range(to)` `range(from, to)` `range(from, to, step)` · `map(seq, f)` `filter(seq, f)`
`reduce(seq, f, initial)` `sum(seq)` · `zip(a, b)` pairs side by side, the extra
tail is dropped · `enumerate(seq)` pairs of `[index, value]` ·
`sorted(seq, cmp?)` `reversed(seq)` — always a new list ·
`from_entries(pairs)` builds a map from a list of `[key, value]`

All of them work on a list, a string and a range; `sorted("cab")` returns
`["a", "b", "c"]` — a list of characters, not a string. `sorted` takes a
*comparison* function (like `sort`), not a key function; the key one is
`sort_by`.

**Maps**
`keys(m)` `values(m)` `entries(m)` — the same as the methods, but they do not
compete with keys

**JSON**
`to_json(v, indent?)` · `from_json(text)` — objects become maps

**Miscellaneous**
`assert(condition, message?)` · `error(value)` · `now()` milliseconds ·
`clock()` seconds with a fraction, for measurements

### More list methods

**Compute:** `sum()` `avg()` `count(f_or_value)` `sum_by(f)` `min_by(f)` `max_by(f)`
**Return a new list:** `unique()` `flatten(depth?)` `take(n)` `drop(n)`
`chunk(n)` `zip(other)` `enumerate()` `sort_by(f)` `flat_map(f)` `partition(f)`
**Other:** `is_empty()` `group_by(f)` → a map

```sable
let people = [{ name: "Ali", age: 30 }, { name: "Vali", age: 25 }]
print(people.sum_by(p -> p.age))              // 55
print(people.min_by(p -> p.age).name)         // Vali
print(people.group_by(p -> p.age).keys())     // [30, 25]
print(range(1, 11).filter(n -> n % 3 != 0).chunk(3).map(c -> c.sum()))
```

```text
55
Vali
[30, 25]
[7, 20, 10]
```

- `avg()` on an empty list is an error: there is nothing to average. `sum()` of
  an empty list is 0.
- `min_by`/`max_by` also require a non-empty list and return the **element**, not
  the key; ties go to the first one.
- `sort_by` is stable: elements with the same key keep their original order. The
  key may be a number or a string; for descending order use `sort_by(p -> -p.price)`.
- `count` understands both a function and a value: `xs.count(1)` counts ones,
  `xs.count(x -> x > 3)` counts the ones that match.
- `flatten()` with no argument unwraps all the way down, `flatten(1)` unwraps one
  level. A list that refers to itself gives an error on a full unwrap, not a hang.
- `group_by` requires the function to return a map key — a string, a number or a bool.
- `flat_map` requires a list from the function: `[1].flat_map(x -> x)` is an
  error, you need `x -> [x]`.
- `zip` truncates to the shorter one, `chunk` returns the last chunk partial,
  `take`/`drop` do not argue with a number larger than the length but do complain
  about a negative one.

### More string methods

`lines()` `words()` `capitalize()` `title()` `is_empty()` `count(substring)`
`trim_start()` `trim_end()` `split_once(sep)` `format(…)`

```sable
let csv = "name,price\nbread,5000\nmilk,12000"
let rows = csv.lines()
let headers = rows.first().split(",")
print(rows.drop(1).map(r -> from_entries(zip(headers, r.split(",")))))
print("Hello, {}! Your balance is {} UZS.".format("Ali", 12000))
```

```text
[{"name": "bread", "price": "5000"}, {"name": "milk", "price": "12000"}]
Hello, Ali! Your balance is 12000 UZS.
```

- `lines()` understands `\r\n`, and a trailing newline does not produce an empty
  last line: `"a\nb\n".lines()` gives two lines, not three.
- `words()` splits on any whitespace and leaves no empty words.
- `capitalize()` and `title()` raise the first letter (of each word) and **leave
  the rest alone**: `"iPhone".capitalize()` is `"IPhone"`. If you want full case
  normalisation — `.lower().title()`.
- `count(substring)` counts without overlaps: `"aaaa".count("aa")` = 2. An empty
  substring is an error.
- `split_once(sep)` cuts at the first occurrence and returns two parts, or `nil`
  if the separator is absent: `"k=v=w".split_once("=")` → `["k", "v=w"]`.
- `format(…)` substitutes the arguments into `{}` in order. The number of holes
  and arguments must match, otherwise it is an error. There is no escaping: a
  `{}` in the template is always a hole. For a string known on the spot, plain
  `${…}` interpolation is shorter.

### More map methods

`map_values(f)` `filter(f)` `pick(keys)` `omit(keys)` `is_empty()` `get_or_insert(k, v)`

```sable
let prices = { bread: 5000, milk: 12000, cheese: 45000 }
print(prices.map_values(v -> v / 1000))       // {"bread": 5, "milk": 12, "cheese": 45}
print(prices.filter(v -> v > 10000).keys())   // ["milk", "cheese"]
print(prices.pick(["cheese", "bread"]))       // {"cheese": 45000, "bread": 5000}
```

```text
{"bread": 5, "milk": 12, "cheese": 45}
["milk", "cheese"]
{"cheese": 45000, "bread": 5000}
```

- The callback in `map_values` and `filter` receives `(value, key)` — a lambda
  with one parameter gets the value, which is what you need more often.
- `map_values`, `filter`, `pick`, `omit` return a **new** map and leave the
  original alone.
- `pick` walks the list of keys, not the map — the order is yours; absent keys
  are simply skipped.
- `get_or_insert(k, v)` stores `v` only if the key is not there yet, and returns
  whatever now sits under the key. It is the only one of the new methods that
  **mutates** the map in place — handy for accumulating:

```sable
let baskets = {}
baskets.get_or_insert("fruit", []).push("apple")
baskets.get_or_insert("fruit", []).push("pear")
print(baskets)                                // {"fruit": ["apple", "pear"]}
```

```text
{"fruit": ["apple", "pear"]}
```

## What version 0.2 does not have

Nesting of expressions and blocks is capped at 150 levels: any deeper and
parsing would blow the stack, and instead of a language error the user would see
a JavaScript stack trace.

Missing: an integer type, C-style counted `for` loops, sets, regular
expressions, concurrency. The order of work is at the end of the [README](../../README.md).

## Diagnostics

Syntax errors are printed **all at once**: parsing continues after each one, so
you do not have to fix a file one typo per run. The first ten are shown — beyond
that the list is usually consequences, not causes.

## Checking without running

`sable --check file.sable` walks the program without executing it and finds
unknown names, writes to a `const`, duplicate declarations, `break` outside a
loop, unreachable code, a wrong number of arguments to functions and to struct
methods, access to a non-existent field, and forgotten variables.

The check is deliberately not built into a normal run: it judges the program
from its text alone and can be wrong where the program actually works — for
example about a name that is only reached inside a `try`.
