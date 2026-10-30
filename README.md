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
  `macros.sub` hold the data and tools macros work with. `roots.sub` finds
  the module a name or a path means, under the module map's rules, for the
  compiler and for sub.
- `substrate/host/`: what runs compiled programs: `subhost.mjs` on Node, and
  `web/` in a browser (experimental).
- `std/`: libraries written in Substrate, a package every program has without
  depending on it. `http/` is an HTTP/1.1 server toolkit; `crypto/`,
  `compress/` and `log/` hold hashes and passwords, DEFLATE and gzip, and
  logs. `meta/` reads types at compile time, for code that writes code;
  `encoding/` holds UTF-8, Base64, JSON and wire (postcard). `package/` reads
  packages and `archive/` tar archives.
- `packages/`: packages outside the standard library. `scheme/`, a Scheme,
  and `bend/`, a dependently typed language, are languages built on
  Substrate, with `nodes/`, the run-time nodes they share. `web/`
  (experimental) holds programs in a web page: a UI library, WebGPU and
  `shade/` for GPU programs compiled to WGSL, a game library, examples and a
  REPL. `sqlite/` is SQLite as a wasm module, with its file layer and API in
  Substrate.
- `cmd/`: a package of sub, the command `bin/sub` runs, which reads packages
  and runs the compiler, and the server `sub serve` runs.
- `seed/`: checked-in builds of the compiler and of sub, which build them
  from source.
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
    make seed                              # and becomes the seed, with sub
    make repl                              # the REPL's site, in build/web/repl
    make docs                              # the toolchain's and packages' documentation, as HTML in build/doc
    bench/*/run.sh                         # benchmarks
