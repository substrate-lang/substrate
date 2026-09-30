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
  - `expander.sub`: `compiler/expander.sub`, but for the cache and
    compiled files, which it says it does not do yet.
  - `running.sub`: the running compiler's build, as the compiler reads
    it until it can compile the kernel module itself (below).
  - `leb128.sub`, `wasm.sub`, `closures.sub`, `serialize.sub` and
    `compile.sub`: the compiler's, into buffers and arenas.
  - `main.sub`: `compiler/main.sub`, with its `build`, `compile` and
    `expand` commands.
- `c/`: the C-like Lisp as the new compiler builds it, `examples/c`'s
  counterpart (plan, 4), which the kernel's tests of it (`tests/c`) run
  on as they run on `examples/c`:
  - `lang.sub`: `examples/c/lang.sub`, its transformers in kernel code,
    function for function.
  - `runtime.sub`, `math.sub` and `c.sub`: `examples/c`'s.
  - `syntax-match.sub`: `lib/substrate.sub`'s patterns for syntax, in
    kernel code, on the kernel module's syntax objects.
  - `kernel-forms.sub`: forms that kernel code is written with, `cond`,
    `and`, `or`, `when`, `unless` and `case`, and Racket's `for` forms on
    lists, as `lib/substrate-core.sub` gives Substrate its forms.
- `sub`: runs the new compiler as `bin/sub` runs the compiler, which
  builds it first when its sources changed: `next/sub build FILE`.
- `compare.sh`: every `.sub` file of the repository expanded, or built,
  by both compilers, which must give the same, a program's linklets byte
  for byte, but where the new compiler differs by design.
- `tests/`: the new compiler's own tests, which it builds (`run.sh`).
- `bench/`: the kernel's scope changes against the new syntax objects'
  (`run.sh`).

The tests of its parts, built by the compiler, are in `tests/next`,
which `tests/run.sh` runs.

## The kernel module

The kernel module (spec 1.2) holds the data of every language built on
the kernel, syntax objects among them, and the functions of the macro
contract (spec 2). The old compiler's, `compiler/kernel.sub`, has them as
GC objects; the new compiler's is `kernel.sub`, with the data in memory,
with the run-time modules it rests on, which give it its memory and
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
  allocator. `(require k kernel)` binds `kernel.sub`'s functions and tags,
  at any phase, and `(memory from k)` and `(table from k)` take its
  memory and table; a linklet at phase 1 or above that declares none
  takes them too.
- **A transformer** is a function pointer, an index in the shared table,
  to a function from syntax to syntax, `(i32) -> i32`, or from an
  environment and syntax, `(make-transformer (func-index code) env)`.
  `define-syntax` values are data too. The expander calls a macro
  directly, through the table.
- **A program** that uses the kernel module carries the running build's
  linklets of it.
- **For now**, until the new compiler compiles the C-like Lisp, and so
  `kernel.sub`, `next/sub` gives it the directory of its own build
  (`-r DIR`), whose program lists the linklets the host registered;
  `kernel.sub`'s functions are read from its linklet's bytes; and the
  memory and allocator are `lib/print.sub`'s and `examples/c`'s, which
  the old compiler builds the new one with. When the C-like Lisp is
  ported (plan, 4), they move into the kernel module, and the new
  compiler compiles `kernel.sub` itself as the old one compiles
  `compiler/kernel.sub`.

Code written for the old compiler's kernel module, its GC data and
syntax objects, Substrate and the C example's `lang.sub` among it, does
not run on the new compiler: those languages are to be built again on the
C-like Lisp (plan, 4 and 5).

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
   module, written in kernel code at the bottom and in the C-like Lisp
   above, with its run-time part in the kernel module; then the C
   example's tests, and the compiler compiling itself, to a fixpoint,
   the current build its first stage. So far: `c/lang.sub` has its
   transformers in kernel code, and the C example's tests, in
   `tests/c`, give their outputs and errors on it. Next, the compiler's
   sources take the C-like Lisp from `c/`, `kernel.sub`'s own macros
   become kernel code, and the compiler builds itself.
5. Substrate as a library on the C-like Lisp, then Bend.
