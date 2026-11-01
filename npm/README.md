# substrate-lang

Substrate is a low-level Lisp for writing WebAssembly: C's types, memory
and control, as s-expressions. Other languages are built on it. Its
compiler is written in it, builds itself, and runs in a browser.

    npm install -g substrate-lang

installs the `substrate` command, and `sub`, short for it. It needs Node 24
or newer.

    substrate build FILE -o DIR              # FILE's program, into DIR
    substrate run [GRANT ...] DIR [ARG ...]  # run it, granted -R, -W, -N, -E, --allow-run or -A
    substrate test [./DIR ...] [PATTERN ...] # the tests of the current package, or of each DIR at once
    substrate compile FILE -o DIR [-m MAP]   # the compiler alone, given the module map that map prints
    substrate version                        # substrate's version, and the hash of its files

The source and the rest of the commands: https://github.com/Ejhfast/substrate-lisp
