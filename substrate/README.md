# substrate

Substrate is a low-level Lisp for writing WebAssembly: C's types, memory
and control, as s-expressions. Other languages are built on it. Its
compiler is written in it, builds itself, and runs in a browser.

## Layout

- `compiler/`: the compiler. Its reader, expander and back end implement
  the kernel, which Substrate expands into: wasm as s-expressions, with
  modules, phases and macros that run at compile time. `checker.sub`
  implements Substrate's forms: it checks their types and turns them into
  the kernel's. `kernel.sub` holds the data macros work on.
- `compiler/substrate/`: Substrate's modules: `lang.sub` binds its forms
  and holds its run-time parts, beside `runtime.sub` and `math.sub`; and
  `syntax-match.sub` and `forms.sub` for writing macros in Substrate.
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
