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
  `macros.sub` hold the data and tools macros work with. `link.sub` makes
  a C side module a module of the program. The compiler builds a program
  from one file and the label of its root, with a module map of roots,
  each a label and a directory, and the names each root uses; it knows
  host, compiler and std itself, whose compile-time code runs in its own
  memory. A map's root's compile-time code runs in a memory of its own,
  unless the map gives the root `(compiler-memory)`: `world.sub` runs the
  root's macros there, and `copier.sub` copies what they take and give. A
  command may also give it a check for each module it reads.
- `std/`: the standard library, written in Substrate. `languages/` holds
  the languages built on it, `scheme/`, a Scheme, and `bend/`, a
  dependently typed language, with `nodes.sub`, the run-time nodes they
  share. `http/` is an HTTP/1.1 server toolkit; `crypto/`, `compress/` and
  `log/` hold hashes and passwords, DEFLATE and gzip, and logs. `meta/`
  reads types at compile time, for code that writes code; `encoding/`
  holds UTF-8, Base64, JSON and wire (postcard). `package/` reads
  manifests, hashes packages and makes module maps. `web/` (experimental)
  holds programs in a web page: a UI library, WebGPU and `shade/` for GPU
  programs compiled to WGSL, a game library, examples and a REPL.
- `packages/`: packages outside the standard library. `sqlite/` is SQLite,
  C compiled to wasm.
- `cmd/`: programs. `sub.sub` is sub, the command for programs, and
  `serve.sub` the server `sub serve` runs.
- `host/`: what runs compiled programs: `subhost.mjs` on Node, and `web/` in a
  browser (experimental).
- `seed/`: a checked-in build of the compiler, which builds it from source.
- `bin/sub`: builds the compiler from the seed and sub with the compiler
  when their sources change, then runs sub.
- `tests/`, `bench/`.

## Packages

A package is a directory with a `package.sub`:

    (package app
      (version "0.1.0")
      (dependencies (sqlite (path "../sqlite"))))

A require names a module by a path, of a file in its own package, or by a
name: `host/fs`, `compiler/macros` and `std/http` are the toolchain's,
and `sqlite` and `sqlite/vfs` a dependency's, its main module and another.
A dependency may pin its package's hash, `(hash "sha256:...")`, which sub
checks. A program may start with a `(package ...)` form of its own, which
makes it a package of one file. Code under no manifest uses the
toolchain's names and its own files by path.

A package builds only from its files, the ones its hash covers: not from
dot-files, its build/, links, or the directories of packages inside it.
A package with C gives other packages typed functions in a binding
module, as `packages/sqlite/sqlite.sub` does, rather than the C functions
themselves.

A package's macros and other compile-time code run in a memory of their
own: what they take from the compiler and give it is copied, so they
cannot change the compiler or what it holds. A dependency the program's
own manifest marks `(trusted)`, as `(sqlite (path "../sqlite") (trusted))`,
runs in the compiler's memory instead, with the packages it depends on,
which saves the copying. A `(trusted)` in another package's manifest
marks nothing, and the program's own package is not trusted. The
toolchain, and code under no manifest, run in the compiler's memory.

A module is known by its package's name and its path there, so a package
builds into the same program wherever it is.

## Commands

In the dev shell (`nix develop`):

    bin/sub build FILE [-o DIR]                 # FILE's program, into build/ of its package
    bin/sub run [GRANT ...] FILE|DIR [ARG ...]  # build FILE, then run, granted -R, -W, -N, -E, --allow-run or -A
    bin/sub eval FILE                           # FILE's forms, one at a time, as a session
    bin/sub expand FILE                         # FILE's expansion
    bin/sub site OUT FILE                       # a web site for a page program
    bin/sub serve OUT                           # serve it locally
    bin/sub pack -o OUT PATH ...                # files packed for a page
    bin/sub hash [DIR]                          # the hash of DIR's package, to pin it
    bin/sub map FILE                            # the module map FILE's program is built with
    make check                                  # the tests
    tests/web/run.sh                            # the browser tests
    make bootstrap                              # the compiler builds itself into the same bytes
    make seed                                   # and becomes the seed
    make repl                                   # the REPL's site, in build/web/repl
    bench/*/run.sh                              # benchmarks
