# substrate

A thin Lisp over WebAssembly whose main addition to wasm is compile-time
execution. Macros are kernel code, compiled to wasm and run by the same
engine that runs the program. The hope is that different languages can be
built as libraries over one small kernel.

`docs/spec.md` starts from its principles (section 1) and fixes what the
bootstrap must preserve: the macro contract, the units of compilation, and
the host interface.

## Layout

What each directory is, and how long it lives. Every source file's first
line says the same.

| Directory | What it holds | Lifecycle |
|---|---|---|
| `docs/` | the kernel specification | permanent |
| `host/` | the host, in C over wasmtime: stores, linking, the `host` imports and the instantiate hook | permanent: after bootstrap it runs the compiler |
| `compiler/` | the compiler, written in the language. Today only `syntax.sub`, the syntax library; the rest arrives as the compiler is rewritten for bootstrap | permanent, grows |
| `stage0/` | the bootstrap compiler, in Chez Scheme: reader, expander, compiler, wasm encoder, FFI | temporary: frozen once the compiler compiles itself |
| `lib/` | libraries in the language that we build on: printing, `write-datum`, `define-macro`, `struct` and `enum`, `match` | permanent, grows |
| `examples/` | demos meant to be read, each a program `NAME.sub` (with `.out` and `.links`) and any modules it requires in `NAME/`; checked by `make check` | grows |
| `tests/` | regression tests: `.sub` programs with `.out` (expected output) or `.err` (expected error), and `.links` (what the compiled phase-0 part may import). `tests/fixtures/` holds modules the tests require | grows |
| `bin/subc` | the entry point | permanent; runs stage0 until bootstrap |

A library in `lib/` is one we intend to build on, not the only way to do
what it does: languages on the kernel can bring their own. If one turns out
to be only illustrative, it moves to `examples/`.

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
use-site scopes, spec 6.2). Modules `require` each other by name, with
qualified imports (`print:write-int`), at any phase:
each phase of a module compiles to its own wasm part, and a program loads
only the parts it reaches at run time (spec 3). Compiled programs import
only what they use:
`(runtime-free)` is checked by the compiler, and `.links` files check
imports in the tests and examples.

`lib/struct.sub` and `lib/match.sub` are the first libraries that work
together: `struct` and `enum` define GC types and leave static
information that `match` reads, checking patterns at compile time.
`examples/shapes.sub` matches, in one module, types defined in another.

Open questions are in `docs/spec.md` section 7.
