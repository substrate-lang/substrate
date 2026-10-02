# next

An experiment: the compiler written in a C-like Lisp, the C example's
(`examples/c`) as the new compiler builds it (`c/`), so that reading,
expanding and compiling need no GC. It is ported from `compiler/` file by
file. It builds itself, from a seed, as the compiler does; the compiler
built its first stage, and nothing in `compiler/`, `lib/` or `host/`
changes for it.

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
    `compile` and `expand` commands, and its cache, `-c DIR`.
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
- `cells/`: an experiment on `substrate/`: Substrate with its values the
  kernel module's cells (plan, 6), so that a program needs no GC and
  Substrate's data at compile time is the kernel module's, syntax
  objects included, and its macros are written in Substrate again:
  - `runtime.sub`: what Substrate's code runs with, in the C-like Lisp:
    closures, boxes, vectors, byte strings, structs, hash tables, ports
    and exceptions as records of the kernel module's, their blocks in
    memory; calls, errors, handlers, writing and the host. Substrate's
    code runs in the heap (`use-heap!`): a program's from its start, and
    at compile time a module's as it starts and a macro's as it is
    called, so that its cells and blocks are owned and freed by their
    last owner; what the compiler makes around it is its module arena's,
    freed with the module.
  - `lower.sub`: closures without the kernel's, and ownership, in the
    C-like Lisp at compile time. A function's body, once expanded, has
    each variable some lambda captures and some code assigns boxed; a
    local function that is only called lifted to a function of the
    variables it captures and its arguments, called directly; and each
    other lambda lifted to a function of the closure and its parameters.
    Its values are owned: the last use of a variable moves its value, an
    earlier use dups it, a variable never used again is dropped, and so
    a program frees what it is done with (`tests/cells/live-cells.sub`).
  - `core.sub`: `substrate/core.sub` on i32 values and the runtime, and
    `define-syntax` whose transformer is Substrate code.
  - `substrate.sub`: `lib/substrate.sub`'s forms, `syntax-match` and
    `match`, written in Substrate at phase 1, as they were; `rules.sub`:
    `syntax-rules`, in C, which `define-syntax` sends it to.
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
  at compile time, and those and the typed example on `cells/`
  (`tests/cells`); the Bend tests of `tests/` and `examples/bend.sub`
  (`tests/bend`), on `bend/`; and the tests of its parts: its syntax
  objects, its reader, and what its expander and back end give for the
  kernel's tests, which is what the compiler gives. Then, as `tests/run.sh` checks the
  compiler's, the cache: every program built again from it is byte for
  byte the same, and a stale entry is not used; and `compiled-import.sub`
  requires a compiled file.

## The kernel module

The kernel module (spec 1.2) holds the data of every language built on
the kernel, syntax objects among them, and the functions of the macro
contract (spec 2). The old compiler's, `compiler/kernel.sub`, has them as
GC objects; the new compiler's is `kernel.sub`, with the data in memory,
with the run-time modules it rests on, which give it its memory and
allocator: `lib/memory.sub`'s memory, which every module of a program
shares, and `c/`'s `sbrk`, stack and allocator. The GC kernel module is not part of the new compiler: the
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
6. Substrate on cells, `cells/`: Substrate's values the kernel module's
   cells, in memory, so that a program needs no GC, and Substrate's data
   at compile time is the kernel module's, syntax objects included, so
   that its macros are written in Substrate, as `lib/substrate.sub`'s
   were, and a macro written in Substrate calls a function written in C
   on its syntax (`tests/cells/c-interop.sub`). Done, without
   reclamation: the Substrate tests, those of Substrate at compile time
   among them, and the typed example (`tests/cells/typed.sub`, a type
   checker written in Substrate as a macro) give their outputs and errors
   on it, with the kernel module as it was. Then the kernel module: a
   word before each cell with a permanent bit and a count of owners,
   cells sized by their case, cells and records on the heap, owned,
   `dup` and `drop`, a dropper per record kind, and fixnums in the datum
   itself; the compiler builds itself in the same time. Then the lowering owning each value
   (`lower.sub`): a function owns its parameters, unless `core.sub`
   marks them `#:borrow`, as the primitives that only read theirs are,
   and what it returns; the last use of a variable moves its value, an
   earlier use dups it, a variable never used is dropped where it is
   bound, a branch drops what only the other branch uses, and `set!`
   drops what it replaces; what a function of the runtime's or the
   kernel module's gives and takes, the pass reads from facts. A local
   function that is only called is a kernel function of the variables
   it captures, called directly, so a loop makes no closure and no box.
   After each check of `tests/cells/live-cells.sub` no more cells are
   in use than before it. Then its speed, against `substrate/` with its
   GC on both hosts. Every primitive was a call into C; now an inline
   function may use memory where the calling module shares it, which
   every module here does (`kernel.sub`, spec 5.2; the kernel module's
   own are found through its group's linklets), so `car`, `cdr`,
   `cons`, dup, drop, a struct's accessors and a closure's captures are
   inline in the program itself, as are fixnum arithmetic and
   comparison; the heap's cells and records' blocks come from a free
   list per size, filled from chunks, so a `cons` is a few stores; a
   closure's code borrows the closure, which its caller keeps through
   the call; the cells in use are counted when asked, not at each
   `cons`. The pass borrows a parameter of a local function it can tell
   is only read, keeps a variable alive through a call that reads it,
   reads `car` and `cdr` without the check where a `pair?` test guards
   them, and takes a pair apart where its owner's last use projects it,
   as Perceus does: the cell is freed, and the next `cons` takes it
   back, so `map`, `filter`, `reverse` and `sort` over a list that
   dies, which `substrate.sub` tells by `unshared-pair?`, make no
   cells; a predicate's or count's result needs no counting
   (`#:free`). A closure or a struct is made inline from the heap's
   lists, and the kernel module frees a record of a kind whose layout
   the runtime registered (`set-record-layout!`) with no call into the
   runtime; a hash table's update hashes its key once. Over 30 M
   iterations, on wasmtime, fixnum arithmetic takes 0.20 s on cells
   against 1.1 s with GC, walking a list 0.14 s against 1.1 s, making
   and freeing pairs 0.29 s against 4.8 s, and 10 M closure calls 0.14
   s against 0.74 s; a list benchmark 0.22 s against 2.1 s, one of
   closures, structs and a hash table 0.13 s against 0.63 s. V8 runs
   the GC version of those in 0.27, 0.18, 0.22, 0.11, 0.17 and 0.07 s,
   and the cells version in 0.21, 0.12, 0.25, 0.12, 0.19 and 0.13 s
   (each with 0.08 s of starting): ahead on arithmetic and walking,
   even on calls and lists, behind by a tenth on making pairs and by
   half on closures, structs and a hash table, where each record freed
   costs what V8's nursery never pays for garbage. The pass costs
   little at compile time: the typed example builds in 0.34 s from a
   warm cache, of which the compiler runs 20 ms, the rest the host
   compiling the compiler. Then memory at compile time, made of one
   piece with memory at run time. There are two lifetimes: a
   compilation, whose data the compiler makes in arenas and frees
   wholesale, a module's with the module, and a program run, whose
   values are owned and freed one by one. The kernel module serves both
   with one kind of cell, permanent in an arena, counted in the heap,
   and the heap is a place chosen as an arena is (`use-heap!`), not a
   mode: Substrate's runtime switches to it as a program starts, as a
   Substrate module's code starts at compile time, and as a Substrate
   macro is called (`apply-transformer`), the way Bend's checker
   switches to an arena of its own per definition. The expander knows
   no language: it makes the arena that was current again after a
   transformer or an instantiation, runs a query from a macro in the
   heap in its own arena, and holds a cell of the heap's a macro gives
   it, a result, or lends a query, a form to lift or expand, as long as
   the module's arena, whose cells refer into it, dropping it with the
   arena (`hold!`); a compile-time value it keeps. On
   Substrate's side a syntax cell, a pair of `reverse` or `append`,
   takes a reference of its own to what it holds while in the heap
   (`dup-held`), the pass treats the kernel's syntax constructors'
   results as owned, a module-level expression of Substrate's is
   converted as a body is, and a function named in `define-syntax` runs
   as its value does (`transformer-value`), in the heap. A macro that
   makes and drops lists, strings, closures and a table leaves no cell
   in use (`tests/cells/live-cells.sub`). The Bend example's checker,
   running as macros, checks the 3200-definition proofs module in 11.0
   s and 3.8 GB on V8 and 12.8 s and 4.0 GB on wasmtime, where before,
   nothing freed until the module was done, it ran out of the 4 GB a
   wasm32 memory has; the GC Substrate's checker takes 12.4 s and 3.1
   GB on V8, the C-like Bend 2.8 s and 1.6 GB. The owners cost time:
   800 definitions take 3.4 s where the arena took 2.8, most of the
   difference dropping cells, among them the results of macro uses the
   expander holds for the module, 9 million cells after 800
   definitions, dropped at its end. Next: a
   closure given to a call that does not keep it, which the facts could
   tell, made on the stack rather than freed; and what still leaks: a
   value a raise unwinds past, and a closure that refers to itself
   through a box, as a letrec's that escapes does.
