# substrate-lang

Substrate is a Lisp for writing WebAssembly. It has C-like semantics
(modernized with generics, variants, bounds-checked slices), combined with
Racket-style hygienic macros and module hooks for defining new languages and
DSLs. Its compiler is small (~11k LOC, <600 KiB of Wasm), very fast,
self-hosted, and runs in the browser.

    npm install -g substrate-lang

installs the `substrate` command, and `sub`, short for it. It needs Node 24
or newer.

    substrate build FILE -o DIR              # FILE's program, into DIR
    substrate run [GRANT ...] DIR [ARG ...]  # run it, granted -R, -W, -N, -E, --allow-run or -A
    substrate test [./DIR ...] [PATTERN ...] # the tests of the current package, or of each DIR at once
    substrate compile FILE -o DIR [-m MAP]   # the compiler alone, given the module map that map prints
    substrate version                        # substrate's version, and the hash of its files
    substrate upgrade                        # the newest substrate, from npm, which this command then runs

The source and the rest of the commands: https://github.com/substrate-lang/substrate
