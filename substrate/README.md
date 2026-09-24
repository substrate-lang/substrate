# substrate

A thin Lisp over WebAssembly whose main addition to wasm is compile-time
execution. Macros are kernel code, compiled to wasm and run by the same
engine that runs the program. The hope is that different languages can be
built as libraries over one small kernel.

`docs/spec.md` starts from its principles (section 1) and fixes what the
bootstrap must preserve: the macro contract, the units of compilation, and
the host interface.

## Layout

- `docs/spec.md`: the kernel specification (v0 draft).
- `host/`: the host, in C over the wasmtime C API. It creates stores,
  links instances by name, and provides the `host` imports, including the
  instantiate hook. It owns no memory.
- `stage0/`: the stage0 compiler in Chez Scheme (reader, expander,
  compiler, wasm encoder, FFI), plus `syntax.sub`, the syntax library:
  syntax objects as wasm GC objects, and the functions macros call.
- `lib/`: ordinary modules: printing, `write-datum`, `define-macro`.
- `tests/`: `.sub` programs, with `.out` (expected output) or `.err`
  (expected error) files, and `.links` (what the compiled phase-0 part may
  import). `tests/modules/` holds modules the tests require.

## Use

Everything runs in the flake's dev shell:

```sh
nix develop
make check                      # build the host library, run the tests
bin/subc run tests/macros.sub   # compile and run a program's main
bin/subc expand FILE            # print fully expanded kernel forms
bin/subc compile FILE -o OUT    # write FILE's parts (phase 0 to OUT)
bin/subc syntax-library -o build/syntax.wasm      # write the syntax library
wasm-tools print OUT            # inspect a module
```

## Status

Stage0 goes from source to a running program: reader, expander, kernel
compiler, binary wasm, then wasmtime. Macros work end to end: a
transformer is a phase-1 function over GC syntax objects, compiled and
instantiated in the compile-time store and called by the expander.
`define-static`, `syntax-local-value`, `syntax-error` and
`free-identifier=?` work too, and macros are hygienic (introduction and
use-site scopes, spec 6.2). Modules `require` and `provide`, at any phase:
each phase of a module compiles to its own wasm part, and a program loads
only the parts it reaches at run time (spec 3). Compiled programs import
only what they use:
`(runtime-free)` is checked by the compiler, and `tests/*.links` checks
imports in the tests.

Open questions are in `docs/spec.md` section 7.
