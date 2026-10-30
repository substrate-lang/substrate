# substrate

Substrate is a low-level Lisp for writing WebAssembly: C's types, memory
and control, as s-expressions. Other languages are built on it. Its
compiler is written in it, builds itself, and runs in a browser.

## Layout

- `substrate/`: the toolchain, `compiler/` and `host/`, and `VERSION`, its
  version. A package may name the oldest it builds with, as
  `(substrate "0.9.0")`.
- `substrate/compiler/`: the compiler, written in Substrate. Its reader,
  expander and back end implement the core forms: wasm as s-expressions, with
  modules, phases and macros that run at compile time. `checker.sub` checks
  and lowers Substrate's other forms. `substrate.sub` is the default language,
  `wasm.sub` gives wasm's forms as `wasm:name`, and `syntax.sub` and
  `macros.sub` hold the data and tools macros work with.
- `substrate/host/`: what runs compiled programs: `subhost.mjs` on Node, and
  `web/` in a browser (experimental).
- `std/`: libraries written in Substrate, a package every program has without
  depending on it. `languages/` holds the languages
  built on it, `scheme/`, a Scheme, and `bend/`, a dependently typed
  language, with `nodes.sub`, the run-time nodes they share. `http/` is an
  HTTP/1.1 server toolkit; `crypto/`, `compress/` and `log/` hold hashes and
  passwords, DEFLATE and gzip, and logs. `meta/` reads types at
  compile time, for code that writes code; `encoding/` holds UTF-8, Base64,
  JSON and wire (postcard). `package/` reads packages and `archive/` tar
  archives. `web/` (experimental) holds programs in a web page: a UI
  library, WebGPU and `shade/` for GPU programs compiled to WGSL, a game
  library, examples and a REPL.
- `packages/`: packages outside the standard library: `sqlite/`.
- `cmd/`: a package of sub, the command `bin/sub` runs, and the server
  `sub serve` runs.
- `seed/`: a checked-in build of the compiler, which builds it from source.
- `docs/`: the documentation of `substrate/`, `std/`, `cmd/` and
  `packages/sqlite/`, each module's declarations and comments as text, from
  `make docs`: `bin/sub doc -o docs substrate std cmd packages/sqlite`.
  `make html` writes it as HTML, into `build/doc`.
- `tests/`, `bench/`.

## Commands

In the dev shell (`nix develop`):

    bin/sub build FILE -o DIR              # FILE's program, into DIR
    bin/sub run [GRANT ...] DIR [ARG ...]  # run it, granted -R, -W, -N, -E, --allow-run or -A
    bin/sub eval FILE                      # FILE's forms, one at a time, as a session
    bin/sub expand FILE                    # FILE's expansion
    bin/sub site OUT FILE                  # a web site for a page program
    bin/sub serve OUT                      # serve it locally
    bin/sub doc                            # the package's documentation, with what it uses, as HTML in its build/doc
    bin/sub doc NAME [ITEM]                # the documentation of module or directory NAME, or of its ITEM
    bin/sub doc -o DIR PACKAGE ...         # packages' documentation as text, or with --html as HTML, into DIR
    bin/sub version                        # substrate's version, and the hash of its files
    make check                             # the tests
    tests/web/run.sh                       # the browser tests
    make bootstrap                         # the compiler builds itself into the same bytes
    make seed                              # and becomes the seed
    make repl                              # the REPL's site, in build/web/repl
    make docs                              # the documentation in docs/
    make html                              # the same as HTML, in build/doc
    bench/*/run.sh                         # benchmarks
