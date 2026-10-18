# substrate

A low-level Lisp for writing WebAssembly, and languages built on it. The
compiler is written in that Lisp, builds itself, and runs in a browser.

## Layout

- `compiler/`: the compiler. Its reader, expander and back end implement
  the kernel, the language's core: wasm as s-expressions, with modules,
  phases and macros that run at compile time. `kernel.sub` holds the data
  macros work on.
- `compiler/base/`: base, the language's C-like layer, written as macros
  over the kernel. The compiler is written in it.
- `lib/`: languages written in base: `scheme/`, a Scheme;
  `bend/`, a dependently typed language; and, experimental, `shade/`, GPU
  programs compiled to WGSL, and `web/`, programs in a web page, a game
  library, examples and a REPL. Beside them is what they share:
  `syntax-match.sub` and `forms.sub` for writing macros in base, and
  `nodes.sub` for run-time nodes.
- `host/`: what runs compiled programs: `subhost.c` on wasmtime,
  `subhost.mjs` on Node, and `web/` in a browser (experimental).
- `seed/`: a checked-in build of the compiler, which builds it from source.
- `tests/`, `bench/`.

## Commands

In the dev shell (`nix develop`):

    make check                        # the tests
    HOST=host/subhost.mjs make check  # the same, on Node
    tests/web/run.sh                  # the browser tests
    make bootstrap                    # the compiler builds itself into the same bytes
    make seed                         # and becomes the seed
    bin/sub build FILE -o DIR         # FILE's program, into DIR
    build/subhost DIR [ARG ...]       # run it
    bin/sub eval FILE                 # FILE's forms, one at a time, as a session
    bin/sub expand FILE               # FILE's expansion
    lib/web/site.sh FILE OUT          # a web site for a page program
    lib/web/repl/site.sh OUT          # the REPL's site
    host/web/serve.mjs OUT            # serve a site locally
    bench/*/run.sh                    # benchmarks
