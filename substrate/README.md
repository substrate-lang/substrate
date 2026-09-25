# substrate

Substrate is a Lisp over WebAssembly. Its kernel's main addition to wasm
is compile-time execution: macros are kernel code, compiled to wasm and run
by the same engine that runs the program. The hope is that different
languages can be built as libraries over one small kernel. The language
most code is written in, also called Substrate, is one of them.

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
| `compiler/` | the compiler, written in Substrate: reader, expander, kernel compiler, wasm encoder, and the syntax library (`syntax.sub`). It compiles itself (spec 1.4) | permanent, grows |
| `stage0/` | the bootstrap compiler, in Chez Scheme: reader, expander, compiler, wasm encoder, FFI | temporary: builds stage1, and checks the compiler, until it is retired |
| `lib/` | libraries in the language that we build on: printing, `write-datum`, `define-macro`, `struct` and `enum`, `match`, and Substrate itself (`substrate.sub`), the language built on the kernel | permanent, grows |
| `examples/` | demos meant to be read, each a program `NAME.sub` (with `.out` and `.imports`) and any modules it requires in `NAME/`; checked by `make check` | grows |
| `tests/` | regression tests: `.sub` programs with `.out` (expected output) or `.err` (expected error), and `.imports` (what the compiled phase-0 linklet may import). `tests/fixtures/` holds modules the tests require | grows |
| `bin/subc` | runs stage0 | temporary, as stage0 |
| `bin/sub` | runs the compiler written in Substrate (`build/sub`) | permanent |

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
bin/subc compile FILE -o OUT    # write FILE's linklets (phase 0 to OUT)
bin/subc syntax-library -o build/syntax.wasm      # write the syntax library
wasm-tools print OUT            # inspect a module
SUBHOST_PROFILE=1 bin/subc run FILE   # time per category, printed at exit
SUBHOST_PROFILE=2 bin/subc run FILE   # also each wasm compile: size, time, instance
SUBHOST_PERFMAP=1 HOST=build/subhost perf record -g bin/sub ...   # wasmtime samples, named by wasm function
bin/sub build FILE -o DIR       # the compiler written in Substrate (build/sub), on V8
build/subhost DIR               # run a built program on wasmtime
host/subhost.mjs DIR            # run it on V8
COMPILER=bin/sub tests/run.sh   # the tests, built by the compiler in Substrate
HOST=host/subhost.mjs tests/run.sh   # run programs, and bin/sub, on that host
```

`make build/sub` builds `build/sub` with stage0. `make bootstrap` builds the
compiler with stage0 (stage1), then with itself twice (stage2, stage3), and
checks that stage2 = stage3 and stage1 = stage2 (spec 1.4).

## Status

The compiler is written in Substrate (`compiler/`) and compiles itself:
built by stage0, then by itself, it reaches its fixpoint, and stage0 and it
write the same bytes (`make bootstrap`, spec 1.4). On V8 it builds itself
in under a second.

Stage0 goes from source to a running program: reader, expander, kernel
compiler, binary wasm, then wasmtime. Macros work end to end: a
transformer is a phase-1 function over GC syntax objects, compiled and
instantiated in the compile-time store and called by the expander.
Compile-time values (`define-syntax`, `syntax-local-value`),
`raise-syntax-error`, `free-identifier=?`, `identifier-binding-kind` and
syntax properties work too, and macros are hygienic
(introduction and use-site scopes, spec 6.2). A module can change what
application and literals mean by binding `#%app` and `#%datum` (spec 5.3,
5.4). Expansion produces fully expanded code, syntax in a fixed grammar (spec
6.4): a macro can see its input's with `local-expand`, a module pass
(spec 6.5) can rewrite a whole module's, and `subc expand` prints it.
Modules `require` each other by name, with
qualified imports (`print:write-int`), at any phase:
each phase of a module compiles to its own wasm module, a linklet, and a
program loads only the linklets it reaches at run time (spec 3). Compiled programs import
only what they use:
`(freestanding)` is checked by the compiler, and `.imports` files check
imports in the tests and examples.

`lib/struct.sub` and `lib/match.sub` are the first libraries that work
together: `struct` and `enum` define GC types and leave compile-time
values that `match` reads, checking patterns at compile time.
`examples/shapes.sub` matches, in one module, types defined in another.
`lib/substrate.sub` is Substrate, the language the compiler is written
in, on the Substrate kernel: every value is an `eqref`, and closure and
assignment conversion run per unit, on fully expanded code, in
Substrate's `#%linklet` (spec 6.5). `examples/effects.sub` is an effect language on Substrate (`examples/effects/handlers.sub`): declared effects, handlers
with a clause per operation, and Koka's evidence passing, built from
`#%app`, `local-expand` and compile-time values.

Open questions are in `docs/spec.md` section 7.
