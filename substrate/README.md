# substrate

Substrate is a Lisp over WebAssembly. Its kernel's main addition to wasm
is compile-time execution: macros are kernel code, compiled to wasm and run
by the same engine that runs the program. The hope is that different
languages can be built as libraries over one small kernel. Three are here:
a C-like Lisp, which the compiler is written in; Substrate, the language
most code is written in, also the project's name; and Bend, a dependently
typed language.

`docs/spec.md` starts from its principles (section 1) and fixes what the
bootstrap must preserve: the macro contract, the units of compilation, and
the host interface.

## Layout

What each directory is, and how long it lives. Every source file's first
line says the same.

| Directory | What it holds | Lifecycle |
|---|---|---|
| `docs/` | the kernel specification | permanent |
| `host/` | the hosts, in C over wasmtime (`subhost.c`) and in JavaScript over Node's V8 (`subhost.mjs`): stores, linking, the `host` imports and the instantiate hook | permanent: they run programs, the compiler among them |
| `compiler/` | the compiler, written in the C-like Lisp: reader, expander, kernel compiler, wasm encoder. It compiles itself (spec 1.4). With it, everything it rests on and carries into programs: the kernel module (`kernel.sub`, in kernel code), the data of every language, in memory, and the functions macros use on it; the forms kernel code is written with (`kernel-forms.sub`, `syntax-match.sub`, `patterns.sub`); the program's memory (`memory.sub`) and printing from it (`print.sub`); and the C-like Lisp itself (`base/`), whose macros are kernel code on the kernel module's data. Nothing here requires anything outside it | permanent, grows |
| `lib/` | the languages built on the kernel, as libraries programs require: Substrate (`substrate/`), on its own values in memory, and Bend (`bend/`), both written in the C-like Lisp on `compiler/` | permanent, grows |
| `tests/` | regression tests: `.sub` programs with `.out` (expected output) or `.err` (expected error). `tests/*.sub` are the kernel's; `tests/base/`, `tests/substrate/` and `tests/bend/` each language's; `tests/fixtures/` holds the modules the tests require | grows |
| `seed/` | the compiler, built by itself: what builds the compiler's source (spec 1.4) | permanent, replaced as the compiler grows |
| `bench/` | benchmarks, each directory with its `run.sh`: `base/`, the C-like Lisp against C; `substrate/`, Substrate's programs; `bend/compile/`, checking and compiling Bend's proofs module; and `compare/`, the same programs in the three languages. `bench/README.md` has the measurements | grows |
| `bin/sub` | runs the compiler (`build/sub`), building it from the seed when its sources changed; `bin/bootstrap` checks the fixpoint and makes the seed | permanent |

A language in `lib/` is one we intend to build on, not the only way to
do what it does: another language on the kernel can bring its own.

- `compiler/`: the compiler, written in the C-like Lisp (`compiler/base/`):
  - `kernel.sub`: the kernel module (below), with its data, syntax
    objects among them, in memory; and the scope sets and syntax
    objects of the expander.
  - `memory.sub`: the program's memory, which every module shares, and
    its layout: the bytes below its `heap-start` are `print.sub`'s, and
    the C language's heap and stack lie above.
  - `print.sub`: output for tests and programs, bytes and integers,
    written with the host's `write` from the program's memory.
  - `kernel-forms.sub`: forms that kernel code is written with, `cond`,
    `and`, `or`, `when`, `unless` and `case`, and Racket's `for` forms on
    lists, its `for` named `for/each`.
  - `syntax-match.sub`: Substrate's patterns for syntax, in kernel code,
    on the kernel module's syntax objects, its code kernel code;
    `patterns.sub`, what it shares with the C-like Lisp's `syntax-match`:
    the pattern words, the parser and the error when no clause matches.
  - `numbers.sub`: the reading and writing of numbers, decimals among
    them.
  - `host.sub`: the host's imports, reading and writing files among them.
  - `reader.sub`: the reader.
  - `core.sub`: the expander's infos, C structs, each with a record, a
    datum, that stands for it in lowered code.
  - `ops.sub`: wasm's instructions, by name.
  - `expander.sub`: the expander, with its cache and compiled files
    (spec 3.7), whose interfaces are of the running compiler, by the
    names of its build's linklets, which carry the hashes of its
    modules: a change to how the compiler compiles is not hidden by
    modules an earlier build compiled. A require's path is relative to
    the file the path is written in, so a require a macro makes names a
    file from the macro's own.
  - `running.sub`: the build that runs the compiler, as the compiler
    reads it: its program's list of linklets, and a linklet's exports and
    imports.
  - `leb128.sub`, `wasm.sub`, `closures.sub`, `serialize.sub` and
    `compile.sub`: the back end, the kernel's forms to wasm, into buffers
    and arenas.
  - `main.sub`: the command, `build` (`-m` included), `compile` and
    `expand`, and its cache, `-c DIR`.
- `compiler/base/`: the C-like Lisp, which the compiler's sources are
  written in:
  - `lang.sub`: the language, its transformers in kernel code. C code quotes data and syntax (`'d`, `#'x`),
    typed as the kernel module's `datum`, as the module of the function
    or global that quotes it names it, with `kernel.sub`'s templates
    `` `t `` and `` #`t ``.
  - `runtime.sub`: the allocator, arenas, buffers and hash tables;
    `math.sub`: C's math functions that wasm has instructions for; and
    `base.sub`, which bundles the three.
  - `syntax-match.sub`: the patterns of `compiler/syntax-match.sub`
    compiled to C, for macros written in C.
  - `forms.sub`: forms for code written in the C-like Lisp, macros
    above all: `for/each` and `for/list` over lists, `fmt`, a message
    formatted from its arguments, and `define-macro`, a macro defined
    with its transformer, `(define-macro (name stx) body ...)`; `lib/bend/`
    writes its macros, loops and messages with them.
- `lib/substrate/`: Substrate as the compiler builds it, on the C-like
  Lisp (plan, 5 and 6): its values nodes in the program's memory, owned
  and freed by the program, so that a program needs no GC; its macros
  written in the C-like Lisp, and Substrate not running at compile time:
  - `values.sub`: Substrate's data in the C-like Lisp: pairs, symbols
    and keywords (interned), strings, integers, flonums and characters,
    with fixnums and characters in the datum itself, #f 0; a header word
    per node with its tag and its count of owners, `dup` and `drop`, a
    free list per size filled from chunks, the drop loop, which frees a
    list cdr by cdr, and the layouts and droppers of the runtime's
    kinds; `quote` and `quasiquote`, whose data a module makes once as
    it starts, permanent, in kernel code, and `lit`, the same in C code.
  - `runtime.sub`: what Substrate's code runs with, in the C-like Lisp:
    closures, boxes, vectors, byte strings, structs, hash tables, ports
    and exceptions as nodes of `values.sub`'s; calls, errors, handlers,
    writing and the host.
  - `lower.sub`: closures without the kernel's, and ownership, in the
    C-like Lisp at compile time. A function's body, once expanded, has
    each variable some lambda captures and some code assigns boxed; a
    local function that is only called lifted to a function of the
    variables it captures and its arguments, called directly; and each
    other lambda lifted to a function of the closure and its parameters.
    Its values are owned: the last use of a variable moves its value, an
    earlier use dups it, a variable never used again is dropped, and so
    a program frees what it is done with (`tests/substrate/live-nodes.sub`).
    A parameter a function only reads is borrowed, its caller keeping
    the value through the call: the module's functions' bodies are
    expanded as its second pass begins, and their flags inferred
    together and written as their facts (`tests/substrate/borrowed.sub`).
  - `core.sub`: `lib/substrate-core.sub`, its transformers kernel code on
    the kernel module's data, its run-time functions kernel code on
    `values.sub`'s and `runtime.sub`'s, which the lowering owns.
  - `substrate.sub`: `lib/substrate.sub`, its forms and `match` written
    in C. A module written in Substrate defines macros with patterns,
    `syntax-rules` (`rules.sub`, in C), which compile into C at its phase
    1, not with Substrate code: Substrate does not run at compile time,
    and has no syntax objects among its values.
- `lib/bend/`: Bend, a port of Bend2's kernel, a dependently
  typed language with quantities, in s-expressions, written in the C-like
  Lisp (plan, 5):
  - `core.sub`: the checker, with a Nat literal a number among its
    terms, however large, and function for
    function, its terms variants in arenas and its binders' bodies data,
    where the example's are Substrate closures; a definition is checked
    in an arena of its own, freed when it is done, and a template's
    instance, checked while the definition that applies it is read, in
    one of its own above it.
  - `bend.sub`: Bend's forms, templates and `print`
    among them, which read a term from its syntax, where the example
    expands it and reads the expansion back; a definition's fact holds its
    terms as bytes and the names they refer to, and the name of its
    function, which is made as soon as the definition is checked.
  - `lower.sub`: the code of definitions and
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
  - `base.sub`: a slice of Bend's Base: its first datatypes, and
    arithmetic and equality on Nat.

## Use

Everything runs in the flake's dev shell:

```sh
nix develop
make check                      # the tests: built by bin/sub, run on build/subhost
bin/sub build FILE -o DIR       # write FILE's program to DIR; the cache is build/cache, or -c DIR (spec 3.7)
bin/sub build FILE -o DIR -m OUT.subc    # and FILE's compiled file, for (require name (compiled "OUT.subc"))
bin/sub -p DIR build FILE ...   # FILE is in the package at DIR (spec 3.6), rather than in this repository
build/subhost DIR [ARG ...]     # run it on wasmtime
host/subhost.mjs DIR [ARG ...]  # run it on V8
bin/sub expand FILE             # print FILE's fully expanded phase-0 forms
bin/sub compile FILE -o OUT     # write FILE's linklets (phase 0 to OUT)
wasm-tools print OUT            # inspect a module
HOST=host/subhost.mjs bin/sub ...    # run the compiler on V8 rather than wasmtime
HOST=host/subhost.mjs tests/run.sh   # run the tests' programs on V8
make bootstrap                  # build/sub builds itself into the same bytes (spec 1.4)
make seed                       # and becomes the seed
```

bin/sub runs the compiler, `build/sub`, on wasmtime, from the package
root, so that a module's bytes, which name its source, are the same
wherever it is built from (spec 3.6); it keeps the modules it compiles in
`build/cache` (spec 3.7), and `rm -rf build/cache` starts over. When the
compiler's sources or the seed are newer than `build/sub`, bin/sub first
builds them with the seed (`seed/`), and them again with that build.

## The kernel module

The kernel module (spec 1.2) holds the data of every language built on
the kernel, syntax objects among them, and the functions of the macro
contract (spec 2), with the data in memory: `compiler/kernel.sub`, with
the run-time modules it rests on, which give it its memory and
allocator, `compiler/memory.sub`'s memory, which every module of a program
shares, and `compiler/base/`'s `sbrk`, stack and allocator. The kernel
language keeps wasm's GC types and instructions, and a language that
wants GC data defines its own.

- **Data** are `i32`s, the addresses of `kernel.sub`'s cells, or fixnums
  in the datum itself, which macros make and take apart with its
  functions (spec 2), `make-integer` and `make-flonum` among them, and
  its buffers for building text. `quote`, `quasiquote`, `quote-syntax` and `quasisyntax` make
  them: a linklet's quoted data is serialized into a data segment, which
  `kernel.sub` reads into the current arena when the linklet starts,
  mapping a syntax object's scopes to the run's (spec 3.5); so a linklet
  that quotes data, at any phase, has the kernel module's memory for its
  own.
- **A syntax error** is `kernel.sub`'s `compile-error` exception, which
  holds the message, the syntax blamed and a source location.
- **Compile-time code** links to the running compiler's instances of the
  kernel module (spec 1.4), so the compiler and every macro share its data, memory and
  allocator: the kernel module's whole group, `kernel.sub` and the
  run-time modules it rests on, at any phase shift, whether a module
  requires it as `kernel` or requires them by path. So a macro can be
  written in the C-like Lisp, a C function at phase 1 on the kernel
  module's data (`tests/c-macros.sub`), as well as in kernel code.
  `(require k kernel)` binds `kernel.sub`'s functions and tags,
  at any phase, and `(memory from k)` and `(table from k)` take its
  memory and table; a linklet at phase 1 or above that declares none
  takes them too. The compiler is given the directory of the build that
  runs it (`-r DIR`, which `bin/sub` passes), whose program lists the
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

The compiler adds to the kernel language, for code it compiles
better: `(values e ...)`, several values, and a `let` binding of them,
`[(x ...) init]` or `[(x ...) (type ...) init]`, so that a function of
several results can be called for them (`tests/let-values.sub`); and
`(br-table (label ...) default index)`, a branch to the label a number
says, as wasm's `br_table` is, so that a switch is one jump
(`tests/br-table.sub`).


## History

The compiler was first written in Substrate, over a kernel module whose
data were wasm GC objects, and built by stage0, a compiler written apart
in Chez Scheme, which wrote the same bytes; stage0 was retired after
commit 3e74bce. The compiler in the C-like Lisp was then written beside
it as an experiment, `next/`, ported from it file by file, built its
first stage with it, and replaced it: both stay in the history. Its
plan, and what each step found:

1. Syntax objects, then the reader. Done: the reader reads the compiler's
   and the libraries' files as `compiler/reader.sub` does, datum for
   datum and location for location.
2. The expander, compiling to wasm, and compile-time code and phases.
   The kernel's tests are the check. Done: every file of the repository
   whose meaning the compiler keeps, the kernel's tests among them,
   it expands and builds as the compiler does, byte for byte, its errors
   and what compile-time code prints included; and the kernel's tests of
   compile-time code, in the new kernel module (`tests/`), give their
   tests' output.
3. `syntax-match`, from `lib/substrate.sub`'s patterns, on the kernel
   module's syntax objects. Done: `compiler/syntax-match.sub`, in kernel code,
   gives the kernel's tests of it, ported to `tests/`, their output:
   `tests/syntax-match.sub`'s, and its error tests' messages.
4. The C-like Lisp, until then an example of a language on the kernel
   (`examples/c/lang.sub`, now `compiler/base/`), as macros on the kernel
   module, written in kernel code, as `lib/substrate-core.sub` writes
   Substrate's, with its run-time part in the kernel module; then the C
   example's tests, and the compiler compiling itself, to a fixpoint,
   the current build its first stage. Done: `c/lang.sub` has its
   transformers in kernel code; the C example's tests, in `tests/base`,
   give their outputs and errors on it; the compiler's sources are
   written in it, `kernel.sub`'s own macros in kernel code; and the
   build the compiler made of them built them into a compiler that
   builds itself into the same bytes, the seed.
5. Substrate and Bend on the C-like Lisp, which is the base language:
   the kernel's specification is what code compiles to, and C is what it
   is written in, with the kernel's instructions in `func` bodies.
   Macros are written in C, and need no GC; Substrate's values were wasm
   GC objects, its run time in `func` bodies, until 6 gave it values of
   its own. In order:
   1. C as a language for macros: quoted data and syntax in C code, and
      `syntax-match` for C. Done: `tests/c-macros.sub`,
      `tests/c-quote.sub`, and `tests/base/syntax-match.sub`, the kernel's
      test of `syntax-match` in C, which gives its output.
   2. Substrate's data, the old kernel module's GC data but syntax, and
      its literals, made when a module starts. Done: `substrate/data.sub`
      (`tests/substrate/data.sub`), since replaced by `values.sub` (6).
   3. Substrate's forms, and pattern macros for Substrate's users. Done:
      `substrate/core.sub` and `substrate/substrate.sub`; the Substrate
      tests of `tests/` give their outputs on them (`tests/substrate`),
      their macros written with `syntax-rules`; both now on the values
      of 6.
   4. Bend, its checker first-order, in C, compiling to linear memory.
      Done: `lib/bend/`; the Bend tests of `tests/` (`tests/bend`) and
      the Bend example (`tests/bend/example.sub`) give their outputs
      and errors on it. Bend2's `proofs_3200` benchmark, checked and
      compiled, builds in 2.9 s on V8 and 3.3 s natively, where the
      example takes 12.7 s.
   5. Numeric instructions and reference types in C code; then the typed
      example.
6. Substrate on its own values, `lib/substrate/` as it is now: Substrate's
   values nodes in the program's memory, owned and freed by the program,
   so that a program needs no GC, with the kernel module as it is and
   Substrate not running at compile time: its macros are written in the
   C-like Lisp, as they were on the GC values, or with `syntax-rules`. The way there
   was an experiment, Substrate on cells, which made Substrate's values
   the kernel module's cells so that its data at compile time was the
   kernel module's, syntax objects included, and its macros could be
   written in Substrate again: it worked, the Substrate tests and a
   type checker written in Substrate as a macro passed on it, but it
   put a facility of owners, a heap beside the arenas, and a hold on
   what a macro gives the expander into the kernel module, two worlds
   in one kind of cell, for the sake of a macro language the C-like
   Lisp already serves (`compiler/base/forms.sub`); so the kernel module was made
   an arena's again, and Substrate given values of its own. What the
   experiment found stays: the lowering that owns each value
   (`lower.sub`), from it.

   `values.sub` is the data, in the C-like Lisp: a datum is an i32, a
   fixnum odd, a character its code shifted with 10 below, #f 0, and
   anything else the address of a node, a multiple of 4, whose first
   word holds its tag in the low byte and its count of owners above,
   the count 2^24 - 1 marking it permanent: nil, #t, every symbol and
   keyword, which are interned, and a module's quoted data. A pair is
   three words; a string, integer, flonum, symbol or keyword a node of
   its own; a closure, box, vector, byte string, struct type, struct,
   hash table, port or exception a node of the runtime's kind
   (`runtime.sub`), whose layout the runtime registers so that the drop
   loop frees it, or whose dropper it does. Nodes come from a free list
   per size up to 64 bytes, filled from chunks past the C heap, and go
   back to it; `dup` adds an owner, `drop` takes one away and at the
   last frees the node and what it holds, a list cdr by cdr and anything
   else through an explicit stack, a pair whose fields need nothing
   freed inline where it is dropped. `quote` makes a module's quoted
   data once, as the module starts, in a C global marked permanent and a
   kernel global holding the same value, so a literal in compiled code
   is a global.get that the lowering knows needs no counting; `lit` is
   the same for C code. The lowering (`lower.sub`) is the experiment's,
   naming `values.sub`'s inline functions: a function owns its
   parameters, unless `core.sub` marks them `#:borrow` or the pass finds
   it only reads them, and what it returns; the last use of a variable
   moves its value, an earlier use dups it, a variable never used is
   dropped where it is bound, a branch drops what only the other branch
   uses, `set!` drops what it replaces; a local function that is only
   called is a kernel function of the variables it captures, called
   directly; a pair whose owner's last use projects it is taken apart
   and its node reused, as Perceus does; `car` and `cdr` of a variable
   that holds its value, borrowed or owned, given to a function that
   only reads them are read where they are, the variable kept through
   the call; and what a function of the runtime's or `values.sub`'s
   gives and takes, the pass reads from facts. After each check of
   `tests/substrate/live-nodes.sub` no more nodes are in use than before
   it; the tests of Substrate at compile time, and the typed example,
   are gone with it.

   Its speed, against the cells experiment and the GC values on V8, each program run twice and the second taken, on this machine
   (the GC versions take 0.08 s to start): over 30 M iterations, on
   wasmtime, fixnum arithmetic takes 0.20 s on owned values against
   0.21 on cells and 0.33 with GC on V8, walking a list 0.16 against
   0.15 and 0.20, making and freeing pairs 0.26 against 0.31 and 0.28,
   and 10 M closure calls 0.14 against 0.15 and 0.14; the list
   benchmark 0.21 against 0.23 and 0.19, the one of closures, structs
   and a hash table 0.13 against 0.14 and 0.11; on V8 the owned
   versions take 0.19, 0.17, 0.26, 0.15, 0.21 and 0.15 s. The untuned
   programs: the interpreter 0.51 s on wasmtime and 0.39 on V8, against
   0.57 and 0.45 on cells and 0.29 with GC; N-queens 0.27 and 0.26
   against 0.29 and 0.29, and 0.21; the string program 0.14 and 0.18
   against 0.18 and 0.21, and 0.17. So owned values are at or ahead of
   cells everywhere, ahead of V8's GC on arithmetic, walking, pairs and
   calls, and behind it where a program makes and frees many short-lived
   pairs, closures and environments: freeing them one by one, through
   `free-node!`, is a tenth of the interpreter's time, which the GC's
   nursery never pays for garbage. The Bend checker written in Substrate
   ran as macros, Substrate at compile time, which this design does not
   run: Bend on the compiler is `lib/bend/`, in the C-like Lisp. Next: a
   closure given to a call that does not keep it, which the facts could
   tell, made on the stack rather than freed; and what still leaks: a
   value a raise unwinds past, and a closure that refers to itself
   through a box, as a letrec's that escapes does.
