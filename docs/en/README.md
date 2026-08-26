# Sable — English documentation

Sable is a general-purpose programming language whose interpreter compiles the
AST to closures. It is written in TypeScript and runs on Node with no build step
and zero runtime dependencies — `node src/cli.ts file.sable` is the whole
toolchain.

```sable
fn fib(n) { if n < 2 { return n }; return fib(n - 1) + fib(n - 2) }
print(fib(20))
```

```text
6765
```

## What is translated so far

| Document | What is inside |
|---|---|
| [LANGUAGE.md](LANGUAGE.md) | the full language reference: syntax, types, operators, collections, functions, structs, modules, errors, standard library, and what version 0.2 does not have |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how the interpreter is built: lexer, parser, values, environments and slot resolution, compilation to closures, modules, checker, formatter, benchmarks, tests |

## Still Russian only

| Document | What is inside |
|---|---|
| [../TUTORIAL.md](../TUTORIAL.md) | the step-by-step tutorial — the gentlest way in, translation pending |
| [../../README.md](../../README.md) | project overview, test suites, roadmap, licence and the name policy (it opens with an English section) |

The interpreter's own **diagnostics are printed in Russian**. Translating them in
the documentation would be a lie about what you will actually see on screen, so
error messages are quoted verbatim here, with an English rendering next to them.

## Running

Node 22.18+ or 24+ is required — from those versions on, TypeScript is executed
natively without flags, so there is nothing to compile. Verified by running the
whole test suite on 22.18, 24 and 25; on 22.17 and earlier it will not start.

To try it without installing anything, use the
**[browser sandbox](https://botiroff-d.github.io/sable/)**: the same interpreter
built for the web. It runs, formats and checks without executing.

```bash
node src/cli.ts examples/01_hello.sable   # run a file
node src/cli.ts                           # interactive session: Tab, history, :помощь
node src/cli.ts -e 'print(2 ^ 10)'        # run a one-liner
node src/cli.ts --check file.sable        # analyse without running
node src/cli.ts fmt -w file.sable         # rewrite in canonical form
node bench/run.ts                         # performance measurements
npm test                                  # run all the suites
```

To call it as plain `sable`:

```bash
npm link
sable examples/04_shapes.sable
```

## What the language can do today

| | |
|---|---|
| Types | `number`, `string`, `bool`, `nil`, `list`, `map`, `range`, `fn`, structs |
| Variables | `let` (mutable), `const` (not) |
| Functions | default values, closures, first class, recursion, lambdas `x -> x * 2` |
| Structs | fields with default values, methods, `self` |
| Control flow | `if`/`else if`/`else`, `while`, `for … in`, `break`, `continue`, ternary `? :` |
| Errors as values | `try`/`catch`, your own throw via `error(…)`, `assert` |
| Modules | `import "lib/math.sable" as math` — the file runs once, cycles are caught |
| Strings | `${…}` interpolation, multiline in \`backticks\`, ~15 methods |
| Collections | `map`/`filter`/`reduce`/`sort`/`find`, slices, negative indexes |
| Diagnostics | source position, a caret under the culprit, a call stack, typo suggestions, all syntax errors in one pass |
| Other | JSON, files, keyboard input |

## Errors worth looking at

```
$ sable pay.sable
Ошибка выполнения: имя «blance» не определено — возможно, имелось в виду «balance»
  --> pay.sable:2:19
  |
2 |   let remaining = blance - amount
  |                   ^
  в withdraw (pay.sable:7:17)
  в main (pay.sable:10:5)
```

In English that reads: *Runtime error: the name «blance» is not defined — did you
mean «balance»?*, followed by the file, line and column, the source line with a
caret under the culprit, and the call stack (`в` = "in").

Every error knows what happened, where exactly, and which calls led there.
Repeated recursion frames collapse into `× N`.

## Layout

```
src/
  lexer.ts        text           → tokens
  parser.ts       tokens         → AST          (recursive descent)
  interpreter.ts  AST            → closures     (compilation and execution)
  checker.ts      AST            → warnings     (checking without running)
  modules.ts      import loading: cache, cycles, paths
  values.ts       runtime values, equality, printing
  environment.ts  scopes and name lookup
  stdlib.ts       built-in functions and type methods
  format.ts       AST            → canonical text (sable fmt)
  errors.ts       one error format, with the caret
  cli.ts          running a file, REPL, -e, --check, fmt
tests/            golden tests: program output is compared against a reference
examples/         examples (their output is locked by tests too)
docs/             tutorial, reference, internals
```

## Documentation is under test

Every code block in this directory that is followed by a printed output block is
actually executed, and the result is compared against what is printed. The
suite that does it is `tests/docs.ts`. Documentation with invented output is
worse than no documentation at all: the reader repeats the example, gets
something else, and stops trusting everything else — so it is locked by a test
rather than by good intentions.

## Licence and name

The code is under [MIT](../../LICENSE), Copyright © 2026 Doniyor Botirov. Fork
it, change it, take it into commercial projects; the only condition is to keep
the copyright notice.

The licence covers the **source code and grants no rights to the name**. "Sable"
is a project name of THE BOTIROFF LLC; the ™ marks a claim to the name, no
registration required. Do not ship a fork under this name, or in a way that
makes it look like the official version — call it something of your own, that is
enough.
