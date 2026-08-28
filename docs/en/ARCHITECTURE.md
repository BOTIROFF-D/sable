# How Sable is built

A program goes through four transformations. Each one lives in its own file, and
each can be inspected on its own — that is the main reason the interpreter is
laid out the way it is.

```
source text
   │  lexer.ts       cuts characters into tokens
   ▼
tokens               LET IDENT ASSIGN NUMBER NEWLINE …
   │  parser.ts      builds a tree out of tokens (recursive descent)
   ▼
AST                  VarDecl{ name: "x", init: Binary{ + , 1, 2 } }
   │  interpreter.ts walks the tree and evaluates it
   ▼
result
```

## Lexer — `src/lexer.ts`

Walks the text left to right and emits a flat list of tokens. Three decisions
here shape the whole language:

**A newline is significant — but not always.** No semicolon is needed because
the lexer itself decides where a statement ends: a `NEWLINE` is emitted only if
the previous token *could* have finished an expression (a number, a name, `)`,
`]`, `}`, `return`, `break`, `continue`). That is why a line cut off at a `+`
continues on the next one. Inside `(…)` and `[…]` newlines are suppressed by
nesting depth — a long call can be laid out however you like.

**Interpolation does not break the token stream.** On meeting `${`, the lexer
does not try to parse the expression itself: it counts matching braces, keeps
the source as a chunk and hands it over along with its position. The parser then
runs itself over that chunk — with the right line and column numbers, so that an
error inside an interpolation points at the real place.

**`1..5` is a range, not a number.** When scanning a number, the dot is consumed
only if a digit follows it.

## Parser — `src/parser.ts`

Recursive descent: one function per precedence level, from the loosest
(`assignment`) to the tightest (`postfix`, `primary`). Right associativity comes
out of recursing into itself (`power` calls `unary`), left associativity out of a
loop (`binaryLevel`).

The language has one genuine ambiguity: is `{` a map or a block body? In
`if x { … }` a human means the body. The parser keeps a `noMapLiteral` counter:
while it is above zero (we are inside the header of an `if`/`while`/`for`), `{`
reads as a block and a map requires parentheses. Inside `(…)` and `[…]` the
counter is reset — there a map is unambiguous again.

Parser errors are human from the start: not "unexpected token" but "expected `)`
at the end of the parameter list, found a name", with a position.

**Parsing does not stop at the first error.** Having caught one, the parser
scans forward to the start of the next statement — a newline, a `;`, or a word a
statement can begin with — and carries on. A single run shows the whole list
rather than the first typo.

Two rules quell the echo that such recovery usually drowns in: one error is
reported per position, and a stray `}` after an error that already happened is
swallowed silently — it is the remnant of a block whose beginning could not be
parsed. The first ten are shown: further down the list are consequences, not
causes.

## Values — `src/values.ts`

Sable values are ordinary JS values wherever possible: number, string, boolean,
`null` for `nil`, `Array` for a list, `Map` for a map. There are only five
classes of its own: `SableFunction`, `NativeFn`, `SableRange`, `StructDef`,
`StructInstance`.

`Map` rather than an object — so that keys can be numbers and `bool`s, and so
that insertion order is honestly preserved.

This is also where `equals` (comparison by content, guarded against cycles),
`repr`/`toStr` (printing) and `truthy` live.

A string is measured in characters in the language, but in UTF-16 code units in
JavaScript: `len("😀")` is one, `"😀".length` is two. Translating between them
costs a walk over the string, so `charAt` and `charLength` ask `isPlain` first:
with no surrogate pairs, a character index is a code-unit index and the access
takes a single step. The answer is remembered for the two most recent strings —
a map will not do here, since it compares keys by content, which is exactly the
cost we are removing. Without that memory, walking a string character by
character grows quadratically; the lock against that regression is
`tests/scale.ts`.

## Environment — `src/environment.ts`

There are two kinds of scope, and that split is what the speed rests on.

**Local** — a function body, a block, one turn of a `for`, a `catch` handler.
Its shape is known at compile time: everything declared in it is visible to the
compiler, and it cannot grow at run time. So names in it are resolved in
advance, and access goes **by slot number** — no string comparison, no walk up a
chain. The shape is shared across all instances of the scope; each call
allocates only an array of values.

**Growing** — the built-in names, the global scope, the top level of a module.
It is added to at run time, so names there are looked up by name. Storage is
two-tier: the first name sits directly in the object's fields, a `Map` appears
from the second one on — nearly all such scopes hold one or two names.

This split sidesteps the trap that usually stops dynamic languages from
resolving to slots at all: a name can appear in a scope after an expression in
it has already been evaluated. But only the global scope can do that — in a
local scope the whole list of names is known ahead of time.

Slots are allocated in advance and filled with a "nothing written here yet"
marker, distinct from `nil`. Without it, a closure created above a declaration
would read emptiness instead of an error: `fn f() { let g = fn() { return y }; let y = 5; return g() }`
must return 5, while a read before the fill must give the ordinary
unknown-name error.

The outermost scope holds the built-in names; a program declares its own in a
child scope, so `let sum = 0` shadows the built-in `sum` rather than colliding
with it. A closure is a function that kept a reference to the environment it was
created in; nothing else is needed for it.

Every iteration of a `for` creates a new environment — which is why closures
created in a loop remember different values of the loop variable.

If a name is not found, the environment looks for the nearest similar one by
Levenshtein distance and suggests it: «возможно, имелось в виду «counter»»
("did you mean «counter»?").

## Interpreter — `src/interpreter.ts`

The tree is not walked on every step: **each node is turned into a closure
once**. `compileExpr(expr)` returns a function `(env) => value`,
`compileStmt(stmt)` returns a function `(env) => signal`. Dispatching on the
node kind happens once, at compile time; what is left in the hot loop is a call
to a ready-made function.

At first this was an ordinary walk with a `switch` on the node kind for every
evaluation. Measurement showed the dispatcher was eating 22–40% of the time;
compiling to closures removed it and gave another 1.3× on top of the earlier
optimisations.

A function body is compiled once per **declaration**, not per creation: a
`fn() { … }` inside a loop produces many function values, but the compiled part
is shared between them. The same part stores the compiled default values.

Scope is passed as a parameter rather than living in a field of the interpreter:
a closure receives `env` and does not depend on what happened before it.

`return`, `break` and `continue` come back as a **value**: `execute` returns the
number `NORMAL`/`RETURN`/`BREAK`/`CONTINUE`, and the `return` value is put in a
field. At first these were exceptions — easier to write, and impossible to
forget to thread through intermediate nodes — but measurement showed one `throw`
costs about 200 ns, that is, half the cost of a function call. A signal that
reaches the top is a source error ("break outside a loop"), and it turns into an
ordinary message.

A call boundary does not let a signal through: a `break` inside a function cannot
stop the loop that called it. It used to — and then the static check, which
counted that as an error, disagreed with the runtime.

This is why `finally` is not merely the host machine's `try/finally`: a signal
arrives as a number, not as an exception, and both have to be intercepted at
once. `compileTry` puts `finally` on as a separate layer over the body (and over
the handler, when there is one): the layer catches both the returned signal and
the thrown error, sets aside the pending `return` value and the pending
`break` location — both live in fields of the interpreter, and any call made
from inside `finally` would overwrite them — runs the `finally` body, and only
then resumes what it set aside. A signal or an error of its own from inside
`finally` overrides the pending one; `--check` warns about that case, and the
language reference names it outright.

The call stack is kept by hand: depth by a counter, while names and locations go
into the report on an error. Repeats collapse into `× N`, so that infinite
recursion does not turn into a wall of text.

Call depth is limited by its own counter (900) rather than by the JS stack:
otherwise the user would get a stack overflow instead of a readable message.

The real capacity is measured by binary search over `SABLE_MAX_DEPTH` and
**depends on the function itself**: the more nested expressions in its body, the
more JS frames go into one Sable call. After the move to closures — about 1980
calls on simple recursion and about 1580 on heavy recursion. The threshold of
900 leaves a 1.5× margin in the worst case; it must not be raised without a
fresh measurement. Once the margin was already eaten down to 887 — below the
threshold, and instead of a language message a Node stack trace came out. That is
why `bench/run.ts` checks this invariant with deliberately heavy recursion.

## Modules — `src/modules.ts`

The loader keeps a cache of "absolute path → exported names" and a list of files
currently being executed. The first gives "a file is executed exactly once", the
second catches an import cycle and prints the whole chain instead of looping.

A module is executed by the same interpreter but in its own environment — a
child of the global one. Whatever is left in that environment after execution is
the export: the language has no separate export keyword.

The source of every loaded file is registered in `errors.ts`. Without that, an
error inside a module would show the line with the same number from the main
file — the most galling kind of lie a diagnostic can tell.

## Checking without running — `src/checker.ts`

The same AST, but instead of evaluating it, a walk with a name table. The main
trick: function bodies are checked not in place but at the end of the block they
are declared in. That literally repeats the language rule "a name is looked up at
the moment of the call", so mutual recursion and a reference to a name declared
below do not produce false errors.

The check deliberately stays quiet where it is not sure: the type of a value is
inferred only from the obvious (`let p = Point(1, 2)`), and if a name is
reassigned anywhere in the program its type is treated as unknown.

For the same reason it is not built into a normal run but lives as a separate
`--check` command: a static judgement about a dynamic language is sometimes
wrong, and the price of a false alarm is a broken run of a working program.

## Formatter — `src/format.ts`

Prints the AST back to text under a single set of rules. There are two
requirements on it: `format(format(x))` equals `format(x)`, and a program after
formatting prints exactly what it printed before. Both are checked on every file
in the repository.

The main difficulty is comments: the lexer throws them away, they are not in the
AST. The formatter makes its own pass over the source and lays comments out
along statement boundaries. Losing them silently is unacceptable, so the test
compares the list of comments before and after.

A list or a dictionary of short values fills the line rather than stretching
into a column: a keyword table at one word per line takes a whole screen and
reads badly. Long values still go one per line — filling only helps where the
values are short and uniform.

## Measurements — `bench/`

`node bench/run.ts` runs programs of varying load and compares against a saved
baseline. The rig appeared before the first optimisation: without numbers, a
"speed-up" is a belief, not work. It also checks that the recursion limit fires
before the Node stack does.

## Standard library — `src/stdlib.ts`

Two parts. Free functions (`print`, `len`, `map`, …) are put into the global
environment. Type methods (`"string".upper()`, `[1].push(2)`) live in tables and
are handed out on demand: `getMember` asks `getMethod`, which finds the entry and
returns a `NativeFn` already bound to its value.

For a map, data outranks methods: `u.name` returns the field even if a method
happened to have that name. Otherwise the user's data structure would break code
depending on what the keys are called.

`value.method(...)` does not create an intermediate function object: the
interpreter takes the implementation from the table and calls it directly. A
separate "binding" is needed only where a method is taken as a value
(`let f = xs.push`).

Callbacks from the standard library are called through `callCallback` rather than
`callValue`: extra arguments (the index in `map`/`filter`) are dropped so that
`xs.map(x -> x * 2)` works. The strict arity check stays for ordinary calls,
where a mismatch is nearly always a mistake.

## Errors — `src/errors.ts`

One class, `SableError`, for all three stages. It knows the stage, the position,
the call stack and the value thrown through `error(…)`. `formatError` prints the
header, the path, the source line and the caret — with an allowance for tabs, so
the arrow does not slide off.

## Tests — `tests/run.ts`, `tests/checker.ts`, `tests/docs.ts`

Golden tests: the program is run with its output captured, and the result is
compared against a reference file. Errors are printed into the same stream, so
the text of an error message is part of the contract too and breaks visibly.

The examples in `examples/` are run by the same runner: their output is fixed in
`tests/examples/`, so it is hard for the language to drift unnoticed.

`--update` overwrites the references — only after you have confirmed with your
own eyes that the new behaviour is correct.

`tests/docs.ts` pulls "code block → output block" pairs out of markdown, runs the
code and compares. Documentation with invented output breaks the build.

## Self-hosting — `selfhost/`

Sable written in Sable — the whole way, from source to execution:

```
lexer.sable         source        → tokens
parser.sable        tokens        → tree
запись.sable        tree          → canonical text form
интерпретатор.sable tree          → execution
встроенные.sable    bridge to the real standard library
main.sable / дерево.sable / запуск.sable — entry points for the cross-checks
```

The standard library is not rewritten: the bridge holds a dictionary from name
to the real builtin, so `len` inside an executed program is the language's own
`len`. Otherwise the cross-check would be testing a second implementation of the
library rather than the language. The interpreter has only five values of its
own — closure, struct definition, instance, module and exit signal; because of
them, printing, `type`, comparison and the methods that take a function have to
be done by hand.

All of it is verified by cross-check, not by examples, on three levels:

| Suite | What is compared | Over what |
|---|---|---|
| `tests/selfhost.ts` | the token stream, then the parse tree | every `.sable` file in the repository, twice |
| `tests/selfrun.ts` | what the program printed | every example and every golden case |

Trees are compared through a canonical text form (`tests/ast-repr.ts` on the real
side, `запись.sable` on the other): one node per line, positions never
serialised — the real lexer counts columns in UTF-16 code units and Sable counts
characters, and on emoji they diverge legitimately.

A program that fails is a result too: both must fail, at the same point in the
output and with the same message. Of the 87 programs compared, 33 do fail, and
their error text matches word for word. A matching refusal is still a match, so
a front end that always refuses would pass the whole cross-check; to keep that
hole shut, both tests separately require most files to have actually parsed and
run.

What the Sable side does not reproduce is listed with a reason for each case and
printed on every run: non-determinism (`random`, `now`), nesting limits (its own
differ) and printing a value that refers to itself.

Both runs together take about four seconds.

The value of this work is not that it sounds impressive but what it finds. Out
of it came `char`/`code` — without them you cannot decode `\u{...}` in the
language itself — `args()` and `apply()` (without the first a program cannot see
its own arguments, without the second it cannot call a function with a computed
list), the fill layout for dictionaries in the formatter, a grammatical-case fix
in the argument-count message, the missing test that `&&` and `||` return the
operand itself, and the fix for quadratic character access on strings.

## What is still the bottleneck

The tree walk is gone, and so is the name lookup along a chain. The next step is
bytecode and a stack VM instead of closures. The lexer and the parser do not
change at all for that: only `interpreter.ts` is replaced, and the tests check
that behaviour stayed the same. A full rebuild of the core has already gone that
way twice, and neither time did a single reference need touching.

Stack capacity after the move to slots is about 1920 calls on simple recursion
and about 1535 on heavy recursion, against a threshold of 900. The number has to
be taken again after every edit to the interpreter: it depends on the number of
JS frames per Sable call.
