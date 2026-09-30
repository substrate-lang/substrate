# next

An experiment: the compiler written in the C example's C
(`examples/c`), so that reading, expanding and compiling need no GC. It is
ported from `compiler/` file by file, and built by that compiler, which
it leaves as it is: nothing in `compiler/`, `lib/` or `host/` changes for
it.

The stack it aims at is the wasm kernel, then a C-like Lisp, then
Substrate as a library on it, able to drop into it, then Bend. Syntax
objects live in the compiler's memory, and the macros of every layer work
on them there.

## Layout

- `compiler/`, the new compiler, its files after `compiler/`'s:
  - `syntax.sub`: syntax objects in memory, which `compiler/kernel.sub`
    has as GC objects, with what `compiler/stx.sub` has on them; and the
    macro contract (below).
  - `numbers.sub`: `compiler/numbers.sub`, with the reading and writing of
    decimals that the old compiler takes from Substrate.
  - `host.sub`: `compiler/host.sub`, with reading and writing files.
  - `reader.sub`: `compiler/reader.sub`.
  - `core.sub`: `compiler/core.sub`, with its infos as C structs, each
    with a record, a datum, that stands for it in lowered code.
  - `ops.sub`: `compiler/ops.sub`.
  - `expander.sub`: `compiler/expander.sub`, but for the cache and
    compiled files, which it says it does not do yet.
  - `running.sub`: the running compiler, as its compile-time code sees
    it (below).
  - `leb128.sub`, `wasm.sub`, `closures.sub`, `serialize.sub` and
    `compile.sub`: the compiler's, into buffers and arenas.
  - `main.sub`: `compiler/main.sub`, with its `build`, `compile`,
    `expand` and `kernel` commands.
- `sub`: runs the new compiler as `bin/sub` runs the compiler, which
  builds it first when its sources changed: `next/sub build FILE`.
- `compare.sh`: every `.sub` file of the repository expanded, or built,
  by both compilers, which must give the same, a program's linklets byte
  for byte.
- `tests/`: the new compiler's own tests, which it builds (`run.sh`).
- `bench/`: the kernel's scope changes against the new syntax objects'
  (`run.sh`).

The tests of its parts, built by the compiler, are in `tests/next`,
which `tests/run.sh` runs.

## The macro contract

The kernel's macro contract (spec 2), with syntax objects in memory:
data are `i32`s, the addresses of `syntax.sub`'s cells, and macros make
and take them apart with `syntax.sub`'s functions, the kernel module's
under their names.

- Compile-time code links to the running compiler's instance of
  `syntax.sub`, as it did to the kernel module's, so the compiler and
  every macro share its data, memory and allocator. `(require s syntax)`
  binds its functions and tags, at any phase, and `(memory from s)` and
  `(table from s)` take its memory and table; a linklet at phase 1 or
  above that declares none takes them too. `next/sub` gives the compiler
  the directory of its own build (`-r DIR`), whose program lists the
  linklets the host registered, and the syntax module's functions are read
  from its linklet's bytes. Until the new compiler compiles the C-like
  Lisp itself, this is how compile-time code reaches the syntax module.
- A transformer is a function pointer, an index in the shared table, to
  a function from syntax to syntax, `(i32) -> i32`, or from an
  environment and syntax, `(make-transformer (func-index code) env)`.
  `define-syntax` values are data too. The expander calls a macro
  directly, through the table.
- `quote-datum`, `quasiquote-datum`, `quote-syntax-datum` and
  `quasisyntax-datum` are `quote` and its kin for data in memory:
  serialized into a data segment, which `syntax.sub` reads into the
  current arena when the linklet starts, mapping a syntax object's scopes
  to the run's (spec 3.5).
- Compile-time code on the kernel's syntax objects, Substrate's and the
  C example's `lang.sub` among it, is not yet in the new compiler: those
  languages are to be built again on the C-like Lisp (plan, below).

## Plan

1. Syntax objects, then the reader. Done: the reader reads the compiler's
   and the libraries' files as `compiler/reader.sub` does, datum for
   datum and location for location.
2. The expander, compiling to wasm, and compile-time code and phases.
   The kernel's tests are the check. Done: the kernel module, and every
   file of the repository that needs no compile-time code or whose
   compile-time code is kernel code alone, the kernel's tests among
   them, it expands and builds as the compiler does, byte for byte, its
   errors and what compile-time code prints included; and the kernel's
   tests of compile-time code, in the contract above (`tests/`), give
   their tests' output.
3. The macro API: patterns and templates.
4. The C-like Lisp as macros written in itself, ported from
   `examples/c/lang.sub`; then the C example's tests, and the compiler
   compiling itself.
5. Substrate as a library on the C-like Lisp, then Bend.
