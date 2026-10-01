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
  at compile time; the Bend tests of `tests/` and `examples/bend.sub`
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
