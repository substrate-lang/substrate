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
    has as GC objects, with what `compiler/stx.sub` has on them.
  - `numbers.sub`: `compiler/numbers.sub`, with the reading and writing of
    decimals that the old compiler takes from Substrate.
  - `host.sub`: `compiler/host.sub`, with reading and writing files.
  - `reader.sub`: `compiler/reader.sub`.
  - `core.sub`: `compiler/core.sub`, with its infos as C structs, each
    with a record, a datum, that stands for it in lowered code.
  - `ops.sub`: `compiler/ops.sub`.
  - `expander.sub`: `compiler/expander.sub`, but for compile-time code,
    the cache and compiled files, which it says it does not do yet.
  - `leb128.sub`, `wasm.sub`, `closures.sub`, `serialize.sub` and
    `compile.sub`: the compiler's, into buffers and arenas.
  - `main.sub`: `compiler/main.sub`, with its `build`, `compile`,
    `expand` and `kernel` commands.
- `sub`: runs the new compiler as `bin/sub` runs the compiler, which
  builds it first when its sources changed: `next/sub build FILE`.
- `compare.sh`: every `.sub` file of the repository expanded, or built,
  by both compilers, which must give the same, a program's linklets byte
  for byte.
- `bench/`: the kernel's scope changes against the new syntax objects'
  (`run.sh`).

Its tests are in `tests/next`, which `tests/run.sh` runs.

## Plan

1. Syntax objects, then the reader. Done: the reader reads the compiler's
   and the libraries' files as `compiler/reader.sub` does, datum for
   datum and location for location.
2. The expander, compiling to wasm, and compile-time code and phases.
   The kernel's tests are the check. Done but for compile-time code: the
   kernel module, and every file of the repository that needs no
   compile-time code, the kernel's tests among them, it expands and
   builds as the compiler does, byte for byte, and its errors are the
   compiler's.
3. The macro API: patterns and templates.
4. The C-like Lisp as macros written in itself, ported from
   `examples/c/lang.sub`; then the C example's tests, and the compiler
   compiling itself.
5. Substrate as a library on the C-like Lisp, then Bend.
