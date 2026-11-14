# substrate-lang

Substrate is a Lisp for writing WebAssembly. It has C-like semantics
(modernized with variants and bounds-checked slices), combined with
Racket-style hygienic macros and module hooks for defining new languages and
DSLs. Its compiler is small (~11k LOC, ~600 KiB of Wasm), very fast,
self-hosted, and runs in the browser.

    npm install -g substrate-lang

installs the `substrate` command, and `sub`, short for it. It needs Node 22
(22.22.3 or newer), Node 24 (24.15 or newer) or Node 25 or newer.

    substrate build [NAME]                   # what the package declares, or one of its programs or sites
    substrate run [GRANT ...] NAME [ARG ...] # one of its programs, granted -R, -W, -N, -E, --allow-run or -A
    substrate build FILE -o DIR              # a program outside packages, into DIR
    substrate run [GRANT ...] DIR [ARG ...]  # a built program
    substrate test [./DIR ...] [PATTERN ...] # the tests of the current package, or of each DIR at once
    substrate compile FILE -o DIR [-m MAP]   # the compiler alone, given the module map that map prints
    substrate version                        # substrate's version, and the hash of its files
    substrate upgrade                        # the newest substrate, from npm, which this command then runs

The source and the rest of the commands: https://github.com/substrate-lang/substrate
