# next

An experiment: the compiler written in a C-like Lisp, the C example's
(`examples/c`) as the new compiler builds it (`c/`), so that reading,
expanding and compiling need no GC. It is ported from `compiler/` file by
file. It builds itself, from a seed, as the compiler does; the compiler
built its first stage, and nothing in `compiler/` or `lib/` changes for
it. In `host/`, the host over V8 is in two parts, so that a browser's
page can be a host too (below, pages).

The stack it aims at is the wasm kernel, then a C-like Lisp, then
Substrate as a library on it, able to drop into it, then Bend. Syntax
objects live in the compiler's memory, and the macros of every layer work
on them there.

## Layout

- `compiler/`, the new compiler, its files after `compiler/`'s:
  - `kernel.sub`: the kernel module (below): `compiler/kernel.sub`, with
    its data, syntax objects among them, in memory; and what
    `compiler/stx.sub` has on them.
  - `numbers.sub`: `compiler/numbers.sub`, with the reading and writing of
    decimals that the old compiler takes from Substrate.
  - `host.sub`: `compiler/host.sub`, with reading and writing files.
  - `reader.sub`: `compiler/reader.sub`.
  - `core.sub`: `compiler/core.sub`, with its infos as C structs, each
    with a record, a datum, that stands for it in lowered code.
  - `ops.sub`: `compiler/ops.sub`.
  - `expander.sub`: `compiler/expander.sub`, with its cache and compiled
    files (spec 3.7), whose interfaces are of the running compiler, by
    the names of its build's linklets, which carry the hashes of its
    modules, where the compiler's are of its kernel: a change to how the
    new compiler compiles is not hidden by modules an earlier build
    compiled. A require's path is relative to the file the path is
    written in, so a require a macro makes names a file from the macro's
    own, where the compiler's names one from the module it expands.
  - `running.sub`: the build that runs the compiler, as the compiler
    reads it: its program's list of linklets, and a linklet's exports and
    imports.
  - `leb128.sub`, `wasm.sub`, `closures.sub`, `serialize.sub` and
    `compile.sub`: the compiler's, into buffers and arenas.
  - `main.sub`: `compiler/main.sub`, with its `build` (`-m` included),
    `compile` and `expand` commands, and its cache, `-c DIR`; and `eval`,
    which evaluates a file's forms one at a time, as a session's inputs
    (below).
- `c/`: the C-like Lisp, `examples/c` as the new compiler builds it,
  which the compiler's sources are written in:
  - `lang.sub`: `examples/c/lang.sub`, its transformers in kernel code,
    function for function. C code quotes data and syntax (`'d`, `#'x`),
    typed as the kernel module's `datum`, as the module of the function
    or global that quotes it names it, with `kernel.sub`'s templates
    `` `t `` and `` #`t ``.
  - `runtime.sub`, `math.sub` and `c.sub`: `examples/c`'s.
  - `syntax-match.sub`: `lib/substrate.sub`'s patterns for syntax, in
    kernel code, on the kernel module's syntax objects, its code kernel
    code; `c-syntax-match.sub`, the same, its code C, for macros written
    in C; `patterns.sub`, what the two share: the pattern words, the
    parser and the error when no clause matches.
  - `kernel-forms.sub`: forms that kernel code is written with, `cond`,
    `and`, `or`, `when`, `unless` and `case`, and Racket's `for` forms on
    lists, its `for` named `for/each`, as `lib/substrate-core.sub` gives
    Substrate its forms.
- `substrate/`: Substrate as the new compiler builds it, on the C-like
  Lisp (plan, 5):
  - `data.sub`: its data, `compiler/kernel.sub`'s but for its syntax
    objects, as wasm GC objects; its `quote`, which makes a datum as its
    value, once, when the module that quotes it starts; and its
    `quasiquote`.
  - `core.sub`: `lib/substrate-core.sub`, its transformers kernel code on
    the kernel module's data, its run-time functions on `data.sub`'s.
  - `substrate.sub`: `lib/substrate.sub`, its forms and `match` written
    in C. A module written in Substrate defines macros with patterns,
    `syntax-rules`, which compile into C at its phase 1, not with
    Substrate code: Substrate does not run at compile time, and has no
    syntax objects among its values.
- `bend/`: Bend as the new compiler builds it, `examples/bend` ported to
  the C-like Lisp (plan, 5):
  - `core.sub`: `examples/bend/core.sub`, the checker, function for
    function, its terms variants in arenas and its binders' bodies data,
    where the example's are Substrate closures; a definition is checked
    in an arena of its own, freed when it is done, and a template's
    instance, checked while the definition that applies it is read, in
    one of its own above it.
  - `bend.sub`: `examples/bend/bend.sub`'s forms, templates and `print`
    among them, which read a term from its syntax, where the example
    expands it and reads the expansion back; a definition's fact holds its
    terms as bytes and the names they refer to, and the name of its
    function, which is made as soon as the definition is checked.
  - `lower.sub`: `examples/bend/lower.sub`, the code of definitions and
    of `print`, in kernel code on values in linear memory, as Bend2's
    runtime has them, where the example's are wasm GC structs: a value
    is a 64-bit term, a Nat or a constructor of no field packed in it,
    else a node of its live fields; a definition whose values are proofs
    or types has no code. A small datatype whose fields are words, not
    recursive, is flat: a value of it is up to 8 words, its constructor's
    number and fields, passed and given as several values, and boxed into
    its node only where one term is held, as a node's field or a
    closure's argument. A match of many ways, or on Nat numbers, is a
    switch, one jump, or, if each way gives a number, a table's; a call
    of a small definition, not recursive, is its code, inlined. A term
    is made a function's code, then kernel code that owns each value
    once, as Bend's quantities allow: a value used again is shared, one
    not used is dropped, and a match frees the node it takes, or reuses
    it for a constructor it builds; a + parameter the code only reads is
    borrowed: read in place, and lent by its caller.
  - `runtime.sub`: what that code runs with: nodes, from lists of the
    freed ones of each size; sharing, a count of owners off the node,
    made the first time a value is shared; dropping; and writing a Nat.
  - `base.sub`: `examples/bend/base.sub`.
- `web/`: a page's programs (below, pages):
  - `ui.sub`: a language for views, on the C-like Lisp: templates,
    compiled to the patches that make and change a page's nodes.
  - `web.sub`: a page's program, a model, its messages and a view, on the
    host module `dom`.
  - `trace.sub`: a batch of patches as text, for tests of views.
  - `site.sh`: a program's site, with the host and its page.
  - `examples/`: a counter (`counter.sub`), and a table of rows
    (`rows.sub`), whose operations `tests/web/rows.mjs` times.
  - `repl/`: the page that is a session of the compiler: `repl.sub`, its
    page and its site.
- `seed/`: a build of the new compiler by itself, checked in, as `seed/`
  is the compiler's.
- `sub`: runs the new compiler as `bin/sub` runs the compiler, keeping
  compiled modules in `build/next/cache`; when its sources changed, it
  first builds them with the seed, and them again with that build, into
  `build/next/sub`: `next/sub build FILE`.
- `bootstrap.sh`: the fixpoint: `build/next/sub` builds itself into the
  same bytes; `next/bootstrap.sh seed` then makes it the seed.
- `compare.sh`: every `.sub` file of the repository expanded, or built,
  by both compilers, which must give the same, a program's linklets byte
  for byte, but where the new compiler differs by design.
- `tests/`: the new compiler's own tests, which it builds (`run.sh`): the
  kernel's tests of compile-time code and of `syntax-match`, on the new
  kernel module; the C example's tests (`tests/c`), on `c/`; the
  Substrate tests of `tests/` (`tests/substrate`), on `substrate/`, with
  their outputs, but for those of Substrate's syntax objects and its code
  at compile time; the Bend tests of `tests/` and `examples/bend.sub`
  (`tests/bend`), on `bend/`; and the tests of its parts: its syntax
  objects, its reader, and what its expander and back end give for the
  kernel's tests, which is what the compiler gives; those of views
  (`tests/ui`), by the patches they write and the errors of templates
  that are wrong; and those of sessions
  (`tests/session`), each a file whose forms `next/sub eval` evaluates.
  `tests/web/run.sh`, apart, runs those that need a browser: the sessions
  again, by the compiler in a page, and the pages of `web/`.
  Then, as `tests/run.sh` checks the
  compiler's, the cache: every program built again from it is byte for
  byte the same, and a stale entry is not used; and `compiled-import.sub`
  requires a compiled file.

## The kernel module

The kernel module (spec 1.2) holds the data of every language built on
the kernel, syntax objects among them, and the functions of the macro
contract (spec 2). The old compiler's, `compiler/kernel.sub`, has them as
GC objects; the new compiler's is `kernel.sub`, with the data in memory,
with the run-time modules it rests on, which give it its memory and
allocator: `lib/print.sub`'s memory, and `c/`'s `sbrk`, stack and
allocator. The GC kernel module is not part of the new compiler: the
kernel language keeps wasm's GC types and instructions, and a language
that wants GC data, as Substrate will, defines its own.

- **Data** are `i32`s, the addresses of `kernel.sub`'s cells, which macros
  make and take apart with its functions, the old kernel module's under
  their names but for `integer` and `flonum`, which are `make-integer` and
  `make-flonum`, and its string builders, which are `lib/print.sub`'s
  buffers. `quote`, `quasiquote`, `quote-syntax` and `quasisyntax` make
  them: a linklet's quoted data is serialized into a data segment, which
  `kernel.sub` reads into the current arena when the linklet starts,
  mapping a syntax object's scopes to the run's (spec 3.5); so a linklet
  that quotes data, at any phase, has the kernel module's memory for its
  own.
- **A syntax error** is `kernel.sub`'s `compile-error` exception, which
  holds the message, the syntax blamed and a source location, where the
  old kernel module throws a syntax error value with its `exn` tag.
- **Compile-time code** links to the running compiler's instances of the
  kernel module, as the old compiler's links to its running kernel's
  (spec 1.4), so the compiler and every macro share its data, memory and
  allocator: the kernel module's whole group, `kernel.sub` and the
  run-time modules it rests on, at any phase shift, whether a module
  requires it as `kernel` or requires them by path. So a macro can be
  written in the C-like Lisp, a C function at phase 1 on the kernel
  module's data (`tests/c-macros.sub`), as well as in kernel code.
  `(require k kernel)` binds `kernel.sub`'s functions and tags,
  at any phase, and `(memory from k)` and `(table from k)` take its
  memory and table; a linklet at phase 1 or above that declares none
  takes them too. The compiler is given the directory of the build that
  runs it (`-r DIR`, which `next/sub` passes), whose program lists the
  linklets the host registered, and reads `kernel.sub`'s functions from
  its linklet there.
- **A transformer** is a function pointer, an index in the shared table,
  to a function from syntax to syntax, `(i32) -> i32`, or from an
  environment and syntax, `(make-transformer (func-index code) env)`.
  `define-syntax` values are data too. The expander calls a macro
  directly, through the table.
- **A program** that uses the kernel module carries the running build's
  linklets of it, but for those it compiled itself: when the compiler
  builds itself, `kernel.sub` compiled from source has the running
  kernel's name, the same module (spec 3.2), and the program has the
  bytes this build compiled, while compile-time code still links to the
  running build's kernel module.

The new compiler adds to the kernel language, for code it compiles
better: `(values e ...)`, several values, and a `let` binding of them,
`[(x ...) init]` or `[(x ...) (type ...) init]`, so that a function of
several results can be called for them (`tests/let-values.sub`); and
`(br-table (label ...) default index)`, a branch to the label a number
says, as wasm's `br_table` is, so that a switch is one jump
(`tests/br-table.sub`).

Code written for the old compiler's kernel module, its GC data and
syntax objects, `lib/` among it, does not run on the new compiler:
Substrate is built again in `substrate/` (plan, 5).

## Sessions

A session is a module that is not finished: its text comes an input at a
time, and each input's code is compiled into a linklet of its own and
run at once, as a module's `begin-for-syntax` is, its phase 0 too
(`expander.sub`, sessions). `next/sub eval FILE` runs one, each form of
`FILE` an input, and reports the inputs that fail (`tests/session`).

- **A session has no language of its own.** It is written in what its
  inputs require, as a file is: `(require-unqualified c ".../c.sub")`
  makes it one in the C-like Lisp, and one that requires nothing is in
  kernel code; kernel code, the C-like Lisp, Substrate and Bend each have
  a test (`tests/session`). A later `require-unqualified` shadows what an
  earlier one bound, but that does not make the session one in the later
  language: the names the earlier bound that the later leaves the
  kernel's, such as `if` and `#%app`, stay the earlier's. A session in
  another language is another session.
- **A definition is there for the inputs after it.** An input is a body
  of its own, so its forms may refer to each other. A definition of a
  name that an earlier input defined shadows it for the inputs after,
  and code compiled before keeps the definition it referred to: a call
  is to a function, not to a name.
- **An expression's value is the language's to show.** An expression
  among an input's forms, `e`, is `(#%top-interaction e)` if that name is
  bound to a macro where `e` is written, as an application is `(#%app f
  arg ...)` (spec 5.3). Substrate's writes the value; the C-like Lisp's
  checks `e` as it does a function's body, and writes its value by its
  type. In kernel code an expression runs, and its value is dropped.
- **An input that fails leaves the session as it was**, but for what its
  code did before it failed: its definitions are taken out. A trap in an
  input's code is the host's failure of `instantiate`, an error like
  another, reported with its backtrace.
- **A session's code is compile-time code.** It runs in the compiler's
  store, and links to the running compiler's instances of the kernel
  module's group: C code in a session has the compiler's memory,
  allocator and stack, as a macro's has, and can write over them. A
  session's linklets are not a program's: there is nothing to build.
- **What an input makes lasts the session**: its syntax and its code are
  in the session's arena, 10 to 30 KB an input.

## Pages

A program can be a page's (`web/`, `host/web`): its views are written as
templates, and its host is a browser's page. `web/repl` is one that is a
session of the compiler, which is its library: what is typed in the page
is compiled and run in the page.

```sh
next/web/repl/site.sh build/next/web/repl    # the site: the program, the host, the page, the sources
host/web/serve.mjs build/next/web/repl       # serve it on this machine; any server of files does
next/web/site.sh FILE OUT                    # the site of another program, FILE's
next/tests/web/run.sh                        # the tests in a browser (Chromium, headless)
```

- **The host** (`host/web/subhost-web.mjs`) is the host of spec 4, on what
  `host/subhost.mjs` and it share (`host/subhost-core.mjs`): a program is
  the directory `sub build` wrote, fetched; its files are a map in memory,
  filled from file packs (`host/web/pack.mjs`); and its instances stay
  when `main` returns, since a page goes on. `instantiate` works as it
  does anywhere, so the compiler runs in a page as it is: its build is
  460 KB, and a session's first input, which compiles Substrate from its
  source, takes a quarter of a second.
- **Host modules.** A linklet can import from a module the page's host
  was given by name, besides `host`: `dom` (`host/web/dom.mjs`) is the
  page's document, and a page can give its own, as `web/repl/page.html`
  gives `out`, what the session's code wrote. What a program imports says
  what it can touch; the compiler's builds are given none, so compile-time
  code in them stays reproducible (spec 4).
- **Events.** The page calls the entry's `on-event` for each event a
  listener is for, as a host calls `main` and `on-trap`; the program asks
  the host for what the event carries, as it asks for an argument, which
  a view's listener does for its message. After a trap the host calls
  `on-trap` and the program goes on (spec 4).
- **Views** (`web/ui.sub`) are a language on the C-like Lisp: a template
  of elements, compiled where it is written. What never changes in it is
  one piece of HTML, made once and copied for each instance; each part
  that can change is a slot of the instance, holding what the page
  shows; and an update works out each slot's value and changes the page
  where it differs. So an update allocates nothing, and costs as the
  view's slots number, not its nodes. A view's structure is all in its
  template (`if`, `each`, a view in another): no code makes a node, which
  is what lets a template be compiled. And its words are HTML's, checked
  where they are written: an element, an attribute of it or an event
  that HTML does not have is an error at the word, as is code of another
  type than its place takes, an attribute that is there or not, as
  `disabled` is, taking a truth, and one that is a number an integer.
- **Patches.** A view changes no page. It writes patches to a buffer, and
  the host applies them as one batch (`dom`'s `apply`): one call out of
  wasm for an update. A program does not hold the page's nodes, only
  numbers for them, so its views can be tested with no page, by the
  patches they write (`tests/ui`, `web/trace.sub`).
- **A page's program** (`web/web.sub`) is a model, the messages that
  change it, and a view of it: a listener holds a message, a value, not
  code, since the C-like Lisp's closures do not outlast their functions;
  what a message takes of its event, as `(event value)`, a field's text,
  is put in it when the event comes, as its field's type; `update`
  changes the model for a message; and the view is brought up to date.
  `web/examples/counter.sub` is one, 19 KB as a program.
- **What it costs** (`web/examples/rows.sub`, timed by
  `tests/web/rows.mjs` in Chromium, from a click to the page laid out
  again): 1,000 rows made in 20 ms and 10,000 in 210 ms; a row of 10,000
  selected, which brings every row up to date, in 0.5 ms; two rows of
  1,000 swapped in 1 ms, and one removed in 0.8 ms.

## Plan

1. Syntax objects, then the reader. Done: the reader reads the compiler's
   and the libraries' files as `compiler/reader.sub` does, datum for
   datum and location for location.
2. The expander, compiling to wasm, and compile-time code and phases.
   The kernel's tests are the check. Done: every file of the repository
   whose meaning the new compiler keeps, the kernel's tests among them,
   it expands and builds as the compiler does, byte for byte, its errors
   and what compile-time code prints included; and the kernel's tests of
   compile-time code, in the new kernel module (`tests/`), give their
   tests' output.
3. `syntax-match`, from `lib/substrate.sub`'s patterns, on the kernel
   module's syntax objects. Done: `c/syntax-match.sub`, in kernel code,
   gives the kernel's tests of it, ported to `tests/`, their output:
   `tests/syntax-match.sub`'s, and its error tests' messages.
4. The C-like Lisp, `examples/c/lang.sub`, as macros on the kernel
   module, written in kernel code, as `lib/substrate-core.sub` writes
   Substrate's, with its run-time part in the kernel module; then the C
   example's tests, and the compiler compiling itself, to a fixpoint,
   the current build its first stage. Done: `c/lang.sub` has its
   transformers in kernel code; the C example's tests, in `tests/c`,
   give their outputs and errors on it; the compiler's sources are
   written in it, `kernel.sub`'s own macros in kernel code; and the
   build the compiler made of them built them into a compiler that
   builds itself into the same bytes, the seed.
5. Substrate and Bend on the C-like Lisp, which is the base language:
   the kernel's specification is what code compiles to, and C is what it
   is written in, with the kernel's instructions in `func` bodies.
   Macros are written in C, and need no GC; Substrate's values are wasm
   GC objects, its run time in `func` bodies. In order:
   1. C as a language for macros: quoted data and syntax in C code, and
      `syntax-match` for C. Done: `tests/c-macros.sub`,
      `tests/c-quote.sub`, and `tests/c/syntax-match.sub`, the kernel's
      test of `syntax-match` in C, which gives its output.
   2. Substrate's data, the old kernel module's GC data but syntax, and
      its literals, made when a module starts. Done: `substrate/data.sub`
      (`tests/substrate/data.sub`).
   3. Substrate's forms, and pattern macros for Substrate's users. Done:
      `substrate/core.sub` and `substrate/substrate.sub`; the Substrate
      tests of `tests/` give their outputs on them (`tests/substrate`),
      their macros written with `syntax-rules`.
   4. Bend, its checker first-order, in C, compiling to linear memory.
      Done: `bend/`; the Bend tests of `tests/` (`tests/bend`) and
      `examples/bend.sub` (`tests/bend/example.sub`) give their outputs
      and errors on it. Bend2's `proofs_3200` benchmark, checked and
      compiled, builds in 2.9 s on V8 and 3.3 s natively, where the
      example takes 12.7 s.
   5. Numeric instructions and reference types in C code; then the typed
      example.
