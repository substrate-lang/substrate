# substrate

Substrate is a low-level Lisp for writing WebAssembly: C's types, memory
and control, as s-expressions. Other languages are built on it. Its
compiler is written in it, builds itself, and runs in a browser.

## Layout

- `substrate/`: the toolchain: `compiler/`, `host/`, and `VERSION`, the
  toolchain's version. A package can require a minimum version, as in
  `(substrate "0.9.0")`.
- `substrate/compiler/`: the compiler, written in Substrate. Its reader,
  expander and back end implement the core forms: wasm as s-expressions, with
  modules, phases and macros that run at compile time. `checker.sub` checks
  and lowers Substrate's other forms. `substrate.sub` is the default language,
  `wasm.sub` gives wasm's forms as `wasm:name`, and `syntax.sub` and
  `macros.sub` hold the data and tools macros work with. `roots.sub` finds
  the module a name or a path means and applies the module map's rules; the
  compiler and sub both use it.
- `substrate/host/`: what runs compiled programs: `subhost.mjs` on Node, and
  `web/` in a browser (experimental).
- `std/`: libraries written in Substrate, as a package every program can use
  without declaring it. `http/` is an HTTP/1.1 server toolkit; `crypto/`,
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
- `cmd/`: a package holding sub, the command `bin/sub` runs, which reads
  packages and runs the compiler, and the server that `sub serve` runs.
- `seed/`: checked-in builds of the compiler and of sub, which build them
  from source.
- `tests/`: the tests of the compiler and the host, as the package
  substrate-tests. Each package's own tests are in its `tests/` directory,
  and `tests/run.sh` runs them all.
- `bench/`: benchmarks.

## Commands

In the dev shell (`nix develop`):

    bin/sub build FILE -o DIR              # FILE's program, into DIR
    bin/sub run [GRANT ...] DIR [ARG ...]  # run it, granted -R, -W, -N, -E, --allow-run or -A
    bin/sub eval FILE                      # FILE's forms, one at a time, as a session
    bin/sub expand FILE                    # FILE's expansion
    bin/sub site OUT FILE                  # a web site for a page program
    bin/sub serve OUT                      # serve it locally
    bin/sub doc                            # documentation of the current package and its dependencies, as HTML in build/doc
    bin/sub doc NAME [ITEM]                # the documentation of module or directory NAME, or of its ITEM
    bin/sub doc -o DIR PACKAGE ...         # packages' documentation as text, or with --html as HTML, into DIR
    bin/sub test [./DIR ...] [PATTERN ...] # the tests of the current package, or of each DIR at once
    bin/sub version                        # substrate's version, and the hash of its files
    make check                             # the tests, then make docs when they pass
    tests/web/run.sh                       # the browser tests
    make bootstrap                         # the compiler builds itself into the same bytes
    make seed                              # the bootstrap check, then the compiler and sub become the seed
    make repl                              # the REPL's site, in build/web/repl
    make docs                              # documentation of the toolchain and the packages, as HTML in build/doc
    bench/*/run.sh                         # benchmarks

## Tests

A test is a `test` form, which only a package's test build compiles:

    (test round-trip
      (expect-equal (decoded (encoded "hello")) "hello"))

`expect` checks a condition, and `expect-equal` compares two values and
shows both when they differ. A package's test modules are the files in its
`tests/` directory, or those its manifest names with `(tests "path" ...)`,
where `*` in a file's name stands for any text. `(grants "flag" ...)` in
that clause gives the test program more grants, as `sub run` takes them.
`sub test` builds all of the package's modules and its test modules into one
program and runs it, and a trap fails only its own test. `std/test/test` compares what code prints
with text or a file, and `std/test/build` checks a file's compile error, and
builds and runs programs in processes of their own.
