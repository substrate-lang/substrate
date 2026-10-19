# substrate

Substrate is a low-level Lisp for writing WebAssembly: C's types, memory
and control, as s-expressions. Other languages are built on it. Its
compiler is written in it, builds itself, and runs in a browser.

## Layout

- `compiler/`: the compiler, written in Substrate. Its reader, expander and
  back end implement the core forms: wasm as s-expressions, with modules,
  phases and macros that run at compile time. `checker.sub` implements
  Substrate's other forms: it checks their types and turns them into core
  forms. `substrate.sub` is the language every module is in unless its
  first form names another: it binds the forms, and holds the memory, the
  stack and Substrate's library. `syntax.sub` holds the data and syntax
  objects that macros work on. `macros.sub` defines the macro tools on them,
  `syntax-match` and `quasiquote` among them, as ordinary macros, and passes
  on `syntax.sub`: a module that writes macros requires it.
- `lib/`: languages written in Substrate: `scheme/`, a Scheme;
  `bend/`, a dependently typed language; and, experimental, `shade/`, GPU
  programs compiled to WGSL, and `web/`, programs in a web page, a game
  library, examples and a REPL. Beside them is what they share:
  `nodes.sub` for run-time nodes.
- `host/`: what runs compiled programs: `subhost.mjs` on Node, and `web/` in a
  browser (experimental).
- `seed/`: a checked-in build of the compiler, which builds it from source.
- `tests/`, `bench/`.

## Commands

In the dev shell (`nix develop`):

    make check                        # the tests
    tests/web/run.sh                  # the browser tests
    make bootstrap                    # the compiler builds itself into the same bytes
    make seed                         # and becomes the seed
    bin/sub build FILE -o DIR         # FILE's program, into DIR
    host/subhost.mjs DIR [ARG ...]    # run it
    bin/sub eval FILE                 # FILE's forms, one at a time, as a session
    bin/sub expand FILE               # FILE's expansion
    lib/web/site.sh FILE OUT          # a web site for a page program
    lib/web/repl/site.sh OUT          # the REPL's site
    host/web/serve.mjs OUT            # serve a site locally
    bench/*/run.sh                    # benchmarks
