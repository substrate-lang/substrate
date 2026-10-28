# substrate

Substrate is a low-level Lisp for writing WebAssembly: C's types, memory
and control, as s-expressions. Other languages are built on it. Its
compiler is written in it, builds itself, and runs in a browser.

## Layout

- `compiler/`: the compiler, written in Substrate. Its reader, expander and
  back end implement the core forms: wasm as s-expressions, with modules,
  phases and macros that run at compile time. `checker.sub` checks and
  lowers Substrate's other forms. `substrate.sub` is the default language,
  `wasm.sub` gives wasm's forms as `wasm:name`, and `syntax.sub` and
  `macros.sub` hold the data and tools macros work with. `link.sub` links
  a package's wasm module into a program.
- `std/`: the standard library, written in Substrate. `languages/` holds
  the languages built on it, `scheme/`, a Scheme, and `bend/`, a
  dependently typed language, with `nodes.sub`, the run-time nodes they
  share. `http/` is an HTTP/1.1 server toolkit; `crypto/`, `compress/` and
  `log/` hold hashes and passwords, DEFLATE and gzip, and logs. `meta/`
  reads types at compile time, for code that writes code; `encoding/`
  holds UTF-8, Base64, JSON and wire (postcard). `web/` (experimental)
  holds programs in a web page: a UI library, WebGPU and `shade/` for GPU
  programs compiled to WGSL, a game library, examples and a REPL.
- `packages/`: packages outside the standard library. `sqlite/` is SQLite,
  C compiled to wasm.
- `cmd/`: the `sub serve` and `sub pack` commands.
- `host/`: what runs compiled programs: `subhost.mjs` on Node, and `web/` in a
  browser (experimental).
- `seed/`: a checked-in build of the compiler, which builds it from source.
- `tests/`, `bench/`.

## Commands

In the dev shell (`nix develop`):

    bin/sub build FILE -o DIR              # FILE's program, into DIR
    bin/sub run [GRANT ...] DIR [ARG ...]  # run it, granted -R, -W, -N, -E, --allow-run or -A
    bin/sub eval FILE                      # FILE's forms, one at a time, as a session
    bin/sub expand FILE                    # FILE's expansion
    bin/sub site OUT FILE                  # a web site for a page program
    bin/sub serve OUT                      # serve it locally
    make check                             # the tests
    tests/web/run.sh                       # the browser tests
    make bootstrap                         # the compiler builds itself into the same bytes
    make seed                              # and becomes the seed
    make repl                              # the REPL's site, in build/web/repl
    bench/*/run.sh                         # benchmarks
