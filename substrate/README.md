# substrate

Substrate is a Lisp over WebAssembly. Its kernel's main addition to wasm
is compile-time execution: macros are kernel code, compiled to wasm and run
by the same engine that runs the program. The hope is that different
languages can be built as libraries over one small kernel. Three are here:
a C-like Lisp, which the compiler is written in; Substrate, the language
most code is written in, also the project's name; and Bend, a dependently
typed language.

`docs/spec.md` starts from its principles (section 1) and fixes what the
bootstrap must preserve: the macro contract, the units of compilation, and
the host interface.

## Layout

What each directory is, and how long it lives. Every source file's first
line says the same.

| Directory | What it holds | Lifecycle |
|---|---|---|
| `docs/` | the kernel specification | permanent |
| `host/` | the hosts, in C over wasmtime (`subhost.c`) and in JavaScript over Node's V8 (`subhost.mjs`): stores, linking, the `host` imports and the instantiate hook; what the JavaScript host shares with the browser is `subhost-core.mjs`, and `host/web/` (experimental) runs programs in a web page, where a program can also run another program in a sandbox (`host/web/guest.mjs`): "Web pages" below | permanent: they run programs, the compiler among them |
| `compiler/` | the compiler, written in the C-like Lisp: reader, expander, kernel compiler, wasm encoder. It compiles itself (spec 1.4). With it, everything it rests on and carries into programs: the kernel module (`kernel.sub`, in kernel code), the data of every language, in memory, and the functions macros use on it; the forms kernel code is written with (`kernel-forms.sub`, `syntax-match.sub`, `patterns.sub`); the program's memory (`memory.sub`) and printing from it (`print.sub`); and the C-like Lisp itself (`base/`), whose macros are kernel code on the kernel module's data. Nothing here requires anything outside it | permanent, grows |
| `lib/` | the languages built on the kernel, as libraries programs require: Substrate (`substrate/`), on its own values in memory, and Bend (`bend/`), both written in the C-like Lisp on `compiler/`; and `web/` (experimental), pages, games and a REPL in the browser, in the C-like Lisp | permanent, grows |
| `tests/` | regression tests: `.sub` programs with `.out` (expected output) or `.err` (expected error). `tests/*.sub` are the kernel's; `tests/base/`, `tests/substrate/` and `tests/bend/` each language's; `tests/ui/` the web libraries' that need no browser, and `tests/session/` the sessions', which `bin/sub eval` runs; `tests/fixtures/` holds the modules the tests require. `tests/web/` are the browser tests, run apart by `tests/web/run.sh` | grows |
| `seed/` | the compiler, built by itself: what builds the compiler's source (spec 1.4) | permanent, replaced as the compiler grows |
| `bench/` | benchmarks, each directory with its `run.sh`: `base/`, the C-like Lisp against C; `substrate/`, Substrate's programs; `bend/compile/`, checking and compiling Bend's proofs module; and `compare/`, the same programs in the three languages. `bench/README.md` has the measurements | grows |
| `bin/sub` | runs the compiler (`build/sub`), building it from the seed when its sources changed; `bin/bootstrap` checks the fixpoint and makes the seed | permanent |

A language in `lib/` is one we intend to build on, not the only way to
do what it does: another language on the kernel can bring its own.

- `compiler/`: the compiler, written in the C-like Lisp (`compiler/base/`):
  - `kernel.sub`: the kernel module (below), with its data, syntax
    objects among them, in memory; and the scope sets and syntax
    objects of the expander.
  - `memory.sub`: the program's memory, which every module shares, and
    its layout: the bytes below its `heap-start` are `print.sub`'s, and
    the C language's heap and stack lie above.
  - `print.sub`: output for tests and programs, bytes and integers,
    written with the host's `write` from the program's memory.
  - `kernel-forms.sub`: forms that kernel code is written with, `cond`,
    `and`, `or`, `when`, `unless` and `case`, and Racket's `for` forms on
    lists, its `for` named `for/each`.
  - `syntax-match.sub`: Substrate's patterns for syntax, in kernel code,
    on the kernel module's syntax objects, its code kernel code;
    `patterns.sub`, what it shares with the C-like Lisp's `syntax-match`:
    the pattern words, the parser and the error when no clause matches.
  - `numbers.sub`: the reading and writing of numbers, decimals among
    them.
  - `host.sub`: the host's imports, reading and writing files among them.
  - `reader.sub`: the reader.
  - `core.sub`: the expander's infos, C structs, each with a record, a
    datum, that stands for it in lowered code.
  - `ops.sub`: wasm's instructions, by name.
  - `expander.sub`: the expander, with its cache and compiled files
    (spec 3.7), whose interfaces are of the running compiler, by the
    names of its build's linklets, which carry the hashes of its
    modules: a change to how the compiler compiles is not hidden by
    modules an earlier build compiled. A require's path is relative to
    the file the path is written in, so a require a macro makes names a
    file from the macro's own; and sessions ("Sessions" below).
  - `running.sub`: the build that runs the compiler, as the compiler
    reads it: its program's list of linklets, and a linklet's exports and
    imports.
  - `leb128.sub`, `wasm.sub`, `closures.sub`, `serialize.sub` and
    `compile.sub`: the back end, the kernel's forms to wasm, into buffers
    and arenas.
  - `main.sub`: the command, `build` (`-m` included), `compile` and
    `expand`, and its cache, `-c DIR`; and `eval`, which runs a file as
    a session: its top-level forms are compiled and run one at a time
    ("Sessions" below).
- `compiler/base/`: the C-like Lisp, which the compiler's sources are
  written in:
  - `lang.sub`: the language, its transformers in kernel code. C code quotes data and syntax (`'d`, `#'x`),
    typed as the kernel module's `datum`, as the module of the function
    or global that quotes it names it, with `kernel.sub`'s templates
    `` `t `` and `` #`t ``.
  - `runtime.sub`: the allocator, arenas, buffers and hash tables;
    `math.sub`: C's math functions that wasm has instructions for; and
    `base.sub`, which bundles the three.
  - `syntax-match.sub`: the patterns of `compiler/syntax-match.sub`
    compiled to C, for macros written in C.
  - `forms.sub`: forms for code written in the C-like Lisp, macros
    above all: `for/each` and `for/list` over lists, `fmt`, a message
    formatted from its arguments, and `define-macro`, a macro defined
    with its transformer, `(define-macro (name stx) body ...)`; `lib/bend/`
    writes its macros, loops and messages with them.
- `lib/substrate/`: Substrate as the compiler builds it, on the C-like
  Lisp (plan, 5 and 6): its values nodes in the program's memory, owned
  and freed by the program, so that a program needs no GC; its macros
  written in the C-like Lisp, and Substrate not running at compile time:
  - `values.sub`: Substrate's data in the C-like Lisp: pairs, symbols
    and keywords (interned), strings, integers, flonums and characters,
    with fixnums and characters in the datum itself, #f 0; a header word
    per node with its tag and its count of owners, `dup` and `drop`, a
    free list per size filled from chunks, the drop loop, which frees a
    list cdr by cdr, and the layouts and droppers of the runtime's
    kinds; `quote` and `quasiquote`, whose data a module makes once as
    it starts, permanent, in kernel code, and `lit`, the same in C code.
  - `runtime.sub`: what Substrate's code runs with, in the C-like Lisp:
    closures, boxes, vectors, byte strings, structs, hash tables, ports
    and exceptions as nodes of `values.sub`'s; calls, errors, handlers,
    writing and the host.
  - `lower.sub`: closures without the kernel's, and ownership, in the
    C-like Lisp at compile time. A function's body, once expanded, has
    each variable some lambda captures and some code assigns boxed; a
    local function that is only called lifted to a function of the
    variables it captures and its arguments, called directly; and each
    other lambda lifted to a function of the closure and its parameters.
    Its values are owned: the last use of a variable moves its value, an
    earlier use dups it, a variable never used again is dropped, and so
    a program frees what it is done with (`tests/substrate/live-nodes.sub`).
    A parameter a function only reads is borrowed, its caller keeping
    the value through the call: the module's functions' bodies are
    expanded as its second pass begins, and their flags inferred
    together and written as their facts (`tests/substrate/borrowed.sub`).
  - `core.sub`: `lib/substrate-core.sub`, its transformers kernel code on
    the kernel module's data, its run-time functions kernel code on
    `values.sub`'s and `runtime.sub`'s, which the lowering owns.
  - `substrate.sub`: `lib/substrate.sub`, its forms and `match` written
    in C. A module written in Substrate defines macros with patterns,
    `syntax-rules` (`rules.sub`, in C), which compile into C at its phase
    1, not with Substrate code: Substrate does not run at compile time,
    and has no syntax objects among its values.
- `lib/bend/`: Bend, a port of Bend2's kernel, a dependently
  typed language with quantities, in s-expressions, written in the C-like
  Lisp (plan, 5):
  - `core.sub`: the checker, with a Nat literal a number among its
    terms, however large, and function for
    function, its terms variants in arenas and its binders' bodies data,
    where the example's are Substrate closures; a definition is checked
    in an arena of its own, freed when it is done, and a template's
    instance, checked while the definition that applies it is read, in
    one of its own above it.
  - `bend.sub`: Bend's forms, templates and `print`
    among them, which read a term from its syntax, where the example
    expands it and reads the expansion back; a definition's fact holds its
    terms as bytes and the names they refer to, and the name of its
    function, which is made as soon as the definition is checked.
  - `lower.sub`: the code of definitions and
    of `print`, in kernel code on values in linear memory, as Bend2's
    runtime has them, where the example's are wasm GC structs: a value
    is a 64-bit term, a Nat or a constructor of no field packed in it,
    else a node of its live fields; a definition whose values are proofs
    or types has no code. A small datatype whose fields are words, not
    recursive, is flat: a value of it is up to 8 words, its constructor's
    number and fields, passed and given as several values, and boxed into
    its node only where one term is held, as a node's field or a
    closure's argument. A match of many ways, or on Nat numbers, is a
    switch, one jump, or, if each way gives a number, a table's; a call
    of a small definition, not recursive, is its code, inlined. A term
    is made a function's code, then kernel code that owns each value
    once, as Bend's quantities allow: a value used again is shared, one
    not used is dropped, and a match frees the node it takes, or reuses
    it for a constructor it builds; a + parameter the code only reads is
    borrowed: read in place, and lent by its caller.
  - `runtime.sub`: what that code runs with: nodes, from lists of the
    freed ones of each size; sharing, a count of owners off the node,
    made the first time a value is shared; dropping; and writing a Nat.
  - `base.sub`: a slice of Bend's Base: its first datatypes, and
    arithmetic and equality on Nat.
- `lib/web/` (experimental): programs that run in a browser and draw a
  web page, written in the C-like Lisp ("Web pages" below):
  - `ui.sub`: a template language for pages ("views").
  - `web.sub`: the structure of a page's program (model, messages,
    update, view) and its connection to the browser.
  - `canvas.sub`: drawing on a `<canvas>` element: rectangles, paths,
    circles, text, and sprites from image files.
  - `gpu.sub`: the program's side of the host module `gpu`, which is
    WebGPU: functions that write its commands.
  - `files.sub`: reading and writing files, which works on every host.
  - `guest.sub`: functions for running another program in a sandbox (a
    "guest"), on hosts that support it.
  - `game/`: a small library for 2D games:
    - `game.sub`: the game loop. `(game World [size 320 180] init step
      draw)` turns three functions into a game in a page; with
      `[renderer gpu]` after the size, the GPU draws its screen.
    - `draw.sub`: what a game draws with: sprite sheets, rectangles and
      text, on either renderer.
    - `sprites.sub`: the GPU renderer: a frame's sprites gathered into
      a batch and drawn with a few commands, on `../gpu.sub`.
    - `meshes.sub`: the GPU renderer for 3D: textured meshes drawn
      from a camera, with depth and fog.
    - `voxels.sub`: worlds made of blocks: the grid, bodies that move
      through it, the block a line of sight hits, and the mesh of a
      part of it. tiles.sub for three dimensions.
    - `math.sub`: sin and cos, which wasm does not have, and the 4 by 4
      matrices a camera needs.
    - `input.sub`: which keys and mouse buttons are held, and which were
      just pressed; how far the mouse moved.
    - `sound.sub`: sound files, music, and short synthesized tones.
    - `timers.sub`: things that happen later: a message that the game
      is handed after a number of steps.
    - `tiles.sub`: levels made of tiles, moving things that are stopped
      by walls and floors, a camera, and levels written as text.
    - `vector.sub` and `store.sub`: containers that check how they are
      used. A vector is a row of items that grows. A store holds
      objects that come and go, and gives out handles that can tell
      when their object has been removed.
    - `format.sub`: text made from a pattern and arguments, such as
      `(format-into line 64 "coins ~d/~d" a b)`. The pattern is read
      at compile time.
    - `trap.sub`: stopping the program, with a message, when it cannot
      go on.
  - `trace.sub`: a test helper that prints what a view would change on
    a page, so that views can be tested without a browser.
  - `site.sh`: builds a program, its page and its assets into a static
    web site.
  - `examples/`: `counter.sub`, a minimal example; `rows.sub`, a table
    with many rows, used to measure performance
    (`tests/web/rows.mjs`); and `snake/`, a small game: `rules.sub` is
    the game itself (rules, timing, random food), `snake.sub` the page
    around it, and `page.html` its HTML; and `platformer/`, a platform
    game built on `game/`: `world.sub` is the game, `platformer.sub`
    puts it in a page, and `assets/` holds its levels, which are text
    files, and its sheet of sprites; and `blocks/`, a world of blocks
    in 3D, built on the same library: `world.sub`, `blocks.sub` and
    the texture atlas in `assets/`.
  - `repl/`: the REPL page. `repl.sub` is the page's program (the user
    interface); `session.sub` is the compiler, which the page runs in a
    sandbox; `page.html` and `site.sh` make the site.

## Use

Everything runs in the flake's dev shell:

```sh
nix develop
make check                      # the tests: built by bin/sub, run on build/subhost
bin/sub build FILE -o DIR       # write FILE's program to DIR; the cache is build/cache, or -c DIR (spec 3.7)
bin/sub build FILE -o DIR -m OUT.subc    # and FILE's compiled file, for (require name (compiled "OUT.subc"))
bin/sub -p DIR build FILE ...   # FILE is in the package at DIR (spec 3.6), rather than in this repository
build/subhost DIR [ARG ...]     # run it on wasmtime
host/subhost.mjs DIR [ARG ...]  # run it on V8
bin/sub expand FILE             # print FILE's fully expanded phase-0 forms
bin/sub compile FILE -o OUT     # write FILE's linklets (phase 0 to OUT)
bin/sub eval FILE               # run FILE's top-level forms one at a time, as a session ("Sessions" below)
lib/web/site.sh FILE OUT        # build the web site of a page program ("Web pages" below)
host/web/serve.mjs OUT          # serve it, and open the address it prints
tests/web/run.sh                # the browser tests, in headless Chromium
wasm-tools print OUT            # inspect a module
HOST=host/subhost.mjs bin/sub ...    # run the compiler on V8 rather than wasmtime
HOST=host/subhost.mjs tests/run.sh   # run the tests' programs on V8
make bootstrap                  # build/sub builds itself into the same bytes (spec 1.4)
make seed                       # and becomes the seed
```

bin/sub runs the compiler, `build/sub`, on wasmtime, from the package
root, so that a module's bytes, which name its source, are the same
wherever it is built from (spec 3.6); it keeps the modules it compiles in
`build/cache` (spec 3.7), and `rm -rf build/cache` starts over. When the
compiler's sources or the seed are newer than `build/sub`, bin/sub first
builds them with the seed (`seed/`), and them again with that build.

## The kernel module

The kernel module (spec 1.2) holds the data of every language built on
the kernel, syntax objects among them, and the functions of the macro
contract (spec 2), with the data in memory: `compiler/kernel.sub`, with
the run-time modules it rests on, which give it its memory and
allocator, `compiler/memory.sub`'s memory, which every module of a program
shares, and `compiler/base/`'s `sbrk`, stack and allocator. The kernel
language keeps wasm's GC types and instructions, and a language that
wants GC data defines its own.

- **Data** are `i32`s, the addresses of `kernel.sub`'s cells, or fixnums
  in the datum itself, which macros make and take apart with its
  functions (spec 2), `make-integer` and `make-flonum` among them, and
  its buffers for building text. `quote`, `quasiquote`, `quote-syntax` and `quasisyntax` make
  them: a linklet's quoted data is serialized into a data segment, which
  `kernel.sub` reads into the current arena when the linklet starts,
  mapping a syntax object's scopes to the run's (spec 3.5); so a linklet
  that quotes data, at any phase, has the kernel module's memory for its
  own.
- **A syntax error** is `kernel.sub`'s `compile-error` exception, which
  holds the message, the syntax blamed and a source location.
- **Compile-time code** links to the running compiler's instances of the
  kernel module (spec 1.4), so the compiler and every macro share its data, memory and
  allocator: the kernel module's whole group, `kernel.sub` and the
  run-time modules it rests on, at any phase shift, whether a module
  requires it as `kernel` or requires them by path. So a macro can be
  written in the C-like Lisp, a C function at phase 1 on the kernel
  module's data (`tests/c-macros.sub`), as well as in kernel code.
  `(require k kernel)` binds `kernel.sub`'s functions and tags,
  at any phase, and `(memory from k)` and `(table from k)` take its
  memory and table; a linklet at phase 1 or above that declares none
  takes them too. The compiler is given the directory of the build that
  runs it (`-r DIR`, which `bin/sub` passes), whose program lists the
  linklets the host registered, and reads `kernel.sub`'s functions from
  its linklet there.
- **A transformer** is a function pointer, an index in the shared table,
  to a function from syntax to syntax, `(i32) -> i32`, or from an
  environment and syntax, `(make-transformer (func-index code) env)`.
  `define-syntax` values are data too. The expander calls a macro
  directly, through the table.
- **A program** that uses the kernel module carries the running build's
  linklets of it, but for those it compiled itself: when the compiler
  builds itself, `kernel.sub` compiled from source has the running
  kernel's name, the same module (spec 3.2), and the program has the
  bytes this build compiled, while compile-time code still links to the
  running build's kernel module.

The compiler adds to the kernel language, for code it compiles
better: `(values e ...)`, several values, and a `let` binding of them,
`[(x ...) init]` or `[(x ...) (type ...) init]`, so that a function of
several results can be called for them (`tests/let-values.sub`); and
`(br-table (label ...) default index)`, a branch to the label a number
says, as wasm's `br_table` is, so that a switch is one jump
(`tests/br-table.sub`).


## Sessions

A session compiles and runs code one piece at a time, as a REPL does. It
is part of the compiler (`compiler/expander.sub`, the "sessions"
section).

```sh
bin/sub eval FILE    # run FILE's top-level forms one at a time, as a session
```

`eval` reports each form that fails and carries on with the next.
`tests/session` has session tests in kernel code, the C-like Lisp,
Substrate and Bend.

How it works: each piece of code typed into a session (an "input") is
compiled into a small wasm module of its own, which is instantiated at
once, inside the running compiler. This is the mechanism that already
runs macros at compile time. A session uses it for ordinary run-time
code too.

- **A session has no fixed language.** As in a file, the language is
  whatever the inputs `require`. `(require-unqualified base ".../compiler/base/base.sub")`
  makes a session in the C-like Lisp, and a session that requires
  nothing is in kernel code. Requiring a second language later does not
  switch the session cleanly: the second language's names replace the
  first's, but basic forms that only the first language defines, such as
  `if` and `#%app`, keep the first language's meaning. To change
  language, start a new session.
- **Definitions last.** A definition made by one input can be used by
  every later input. Defining a name again replaces it for later inputs.
  Code that was compiled earlier keeps using the old definition, because
  a compiled call refers to a function, not to a name.
- **The language decides how values are shown.** When an input contains
  an expression `e`, the compiler rewrites it to `(#%top-interaction e)`
  if the session's language binds that name to a macro. (A function call
  becomes `(#%app f arg ...)` by the same convention, spec 5.3.)
  Substrate's macro prints the value. The C-like Lisp's macro
  type-checks `e` as it would a function body, and prints the value
  according to its type. Kernel code has no such macro: an expression is
  run and its value is dropped.
- **A failed input changes nothing**, apart from whatever its code had
  already done when it failed: its definitions are removed. A trap in an
  input's code is reported like any other error, with a backtrace.
- **Inputs are trusted.** An input's code runs inside the compiler. It
  links to the modules the compiler itself is running, and C-like Lisp
  code in a session shares the compiler's memory, allocator and stack,
  and can overwrite them. A program that evaluates code it does not
  trust should run the whole session in a sandbox, as the REPL page does
  (see "Guests" below).
- **Memory grows.** What an input creates, its syntax and its code, is
  kept for as long as the session lasts: 10 to 30 KB per input.

## Web pages

A program can run in a browser and draw a web page. `lib/web/` has the
libraries for this, and `host/web` has the JavaScript that runs a
compiled program in a page. The demonstration is `lib/web/repl`, a REPL in
which everything that is typed is compiled and run in the browser.

```sh
lib/web/repl/site.sh build/web/repl    # build the REPL's web site
host/web/serve.mjs build/web/repl       # serve it, and open the address it prints
lib/web/site.sh FILE OUT                    # build the site of another program
tests/web/run.sh                        # run the browser tests (headless Chromium)
```

A site is made of static files only, so any web server can serve it.
The browser tests need Chromium, which the flake's dev shell brings:
nixpkgs' on Linux, and on macOS, where nixpkgs builds none, the Chrome
for Testing build that Playwright's browsers package fetches, as
`chromium`; `CHROMIUM` names another browser (`host/web/browser.mjs`).

### The pieces

- **The browser host** (`host/web/subhost-web.mjs`). A "host" loads a
  compiled program and provides its imports (spec 4). Most of that code
  is shared between Node and the browser (`host/subhost-core.mjs`). The
  browser's part fetches the program's modules over HTTP, and keeps the
  program's "files" in memory. A page says which files to download for
  the program before it starts: the files named in a list, or many
  files stored in one, a "file pack" (`host/web/pack.mjs`). It also
  keeps the program alive after `main` returns, so that the program can
  respond to events. The compiler itself runs in a browser unchanged;
  its build is 460 KB.
- **Host modules.** Besides the standard `host` imports, a page can give
  a program extra modules of host functions, each under a name. A
  program can only use the modules it is given, so they also work as
  permissions. There are four: `dom` (`host/web/dom.mjs`), for drawing
  on the page; `audio` (`host/web/audio.mjs`), for sound; `gpu`
  (`host/web/gpu.mjs`), for WebGPU; and `guest`
  (`host/web/guest.mjs`), for running other programs in a
  sandbox. The compiler is run with no extra modules, so
  code that runs at compile time cannot use them, and builds stay
  reproducible (spec 4).
- **Views** (`lib/web/ui.sub`): a template language for pages, built on the
  C-like Lisp. A view looks like the HTML it produces, with holes for
  the parts that depend on the program's data. Views are compiled. The
  constant parts of a view become one HTML string, which the browser
  parses once and clones for each instance. Each hole remembers its last
  value; an update recomputes the holes and changes the page only where
  a value differs. So an update allocates nothing, and its cost depends
  on the number of holes, not on the size of the page. The names of HTML
  elements, attributes and events are checked at compile time, and so
  are the types of expressions: a boolean attribute such as `disabled`
  takes a condition, and a numeric one takes an integer. Errors point at
  the word or the expression in the template.
- **Patches.** A view never touches the page itself. It writes "patches",
  small binary instructions, into a buffer, and the host applies the
  whole buffer in one call. This keeps the number of calls between wasm
  and JavaScript low. It also means that views can be tested without a
  browser, by printing the patches (`tests/ui`, `lib/web/trace.sub`).
- **Program structure** (`lib/web/web.sub`): a model (all of the program's
  state), a message type (everything that can happen), an `update`
  function, and a view. The design is Elm's. An event listener in a
  template names the message to send, and the message can carry data
  from the event, such as `(event value)` for the text of a field, or
  `(event movement-x)` for how far the mouse moved. Messages are data
  rather than callbacks, because the C-like Lisp's closures cannot be
  stored. A few things a page does are not changes to its content but
  requests to the browser, written as attributes whose integer changes:
  `[focus e]`, `[scroll-end e]` and `[pointer-lock e]`, which hides the
  cursor and reports the mouse's movement without limits, as a game
  that looks around with the mouse needs; the browser grants it only in
  response to a click. Things that happen outside the page, such
  as a reply from a guest, are turned into messages with `send!`.
  `lib/web/examples/counter.sub` is a minimal example; its compiled program
  is 20 KB.
- **Canvas** (`lib/web/canvas.sub`): drawing with code instead of with
  elements. A `<canvas>` is an ordinary element in a view, with one
  extra attribute: `[draw key code]` runs `code` when the canvas is
  created and again whenever `key` changes. `code` calls drawing
  functions such as `fill-rect`, `fill-circle` and `fill-text`. Drawing
  uses the same mechanism as the rest of a view: each function writes
  a small command into the patch buffer, and the host carries them all
  out in one call. So a canvas needs no engine of its own, and a whole
  frame of drawing is still one call from wasm to JavaScript.
- **Window events and animation frames.** `[on-window event message]`
  listens on the browser window instead of on one element, for things
  like a key pressed anywhere on the page. The event name `frame`
  sends a message for every frame the browser draws, which is what an
  animation or a game runs on. These are listeners like any other:
  they produce messages, they can carry event data (`(event time)`,
  `(event key)`, and `(event x)` and `(event y)` for the mouse), and
  they are removed when the element they are written on is removed.
- **Assets.** A program's assets are the files in a directory called
  `assets` next to its source: images, text, level data, anything.
  `site.sh` copies them into the site, where they are ordinary static
  files. So the page can use one by its URL, `assets/NAME`, wherever
  the browser takes a URL: the `src` of an `<img>` in a view, a style
  sheet, `load-image`. The program can also read them as files
  (`lib/web/files.sub`): `site.sh` writes their names in `assets.list`, and
  the page downloads the files in that list before it starts the
  program. Nothing in the program is specific to the browser. The
  same program, run on the command line in its own directory, reads
  the same paths from disk. The default page downloads every asset
  before the program starts, which suits a small program or a game.
  A site with many or large assets should use a page of its own that
  lists only the files its program reads.
- **Images and sound.** `load-image` loads an image, usually one of the
  program's assets, and `draw-sprite` draws one cell of it, optionally
  mirrored: an image can be a "sprite sheet", a grid of small pictures
  such as the frames of an animation. Sound comes from files, which
  are assets too: `load-sound` loads one, `play-sound` plays it once,
  and `play-music` plays it again and again. Sound can also be
  synthesized: `play-tone` plays a short tone whose pitch slides from
  one frequency to another, which is enough for the jumps, coins and
  bumps of a retro game, and needs no files.
- **The game library** (`lib/web/game/`). A page program is driven by
  messages, which suits a user interface. A game is easier to write as
  a loop: sixty times a second, look at the keys and move everything;
  then draw. `(game World [size 320 180] init step draw)` provides that
  loop. It calls `step` at a steady rate whatever the screen's refresh
  rate, hands it the state of the keyboard (which keys are held, and
  which were pressed since the last step), plays the sounds the game
  asked for, and draws every frame on a canvas of exactly the size
  given, which the browser stretches to the window without blurring.
  It is a macro that expands into an ordinary page program. A game
  draws with `draw.sub`: sprite sheets, rectangles and text, in the
  pixels of its screen, with colours as numbers (`#x8fd3ffff`). The
  same calls work on both renderers below. A game that looks around
  with the mouse says `[pointer lock]`: a click on its screen then locks
  the pointer to it, and the mouse's movement and buttons reach the
  game's step function through the input, as the keys do; Escape frees
  the pointer.
  `tiles.sub` adds what a platformer or a top-down game needs: a level
  as a grid of tiles, bodies that move through it and are stopped by
  walls, floors and ceilings, and a camera that follows the player.
  `timers.sub` is for things that happen later. A timer carries a
  message, a value of a variant type that the game defines, and the
  game's step function is handed the message when its time has come.
  (It is a message and not a function to call, because a closure in
  this language lasts only as long as the call that made it.)
  Only the loop itself needs a browser. A game's own code uses the
  keyboard state, the sound lists and the drawing commands, none of
  which does, so a game can be played by a test.
- **Guarding against mistakes in a game** (`game/vector.sub`,
  `game/store.sub`, `game/format.sub`, `game/trap.sub`). The C-like
  Lisp, like C, does not check what a program does with memory: an
  index that is out of range reads or writes some other part of the
  program's data. These files check where it matters most in a game.
  They are part of the game library, written for its needs. They are
  not standard libraries of the language, which is unchanged.
  - A vector is a row of items that grows. Asking for an item that is
    not there stops the program with a message. Code that already
    knows its index is good can ask without the check. A vector's
    items never move, so a pointer to one stays good while the vector
    grows.
  - A store holds objects that come and go, such as a game's enemies.
    To remember an object for later, a program keeps a handle. A
    handle can tell that its object has been removed, which a pointer
    cannot, and the compiler rejects a handle that is used with a
    store of another type.
  - A formatting pattern, such as `"coins ~d/~d"`, is read at compile
    time. A pattern that does not match its arguments is a compile
    error.
  - `trap` stops the program with a message. On the command line the
    program ends. In a page, a game stops and shows the message, with
    the functions that were running and their places in the source,
    on top of its screen.

  What they do not do: plain arrays and pointers are still unchecked,
  so code that uses those directly is as unsafe as before.
- **WebGPU** (`host/web/gpu.mjs`, `lib/web/gpu.sub`). The host module
  `gpu` is WebGPU for a program, the way `dom` is the page for it. It
  knows nothing about sprites, meshes or text. The program numbers its
  own resources (shaders, pipelines, buffers, textures, samplers, bind
  group layouts, bind groups, and surfaces, which are canvases of the
  page), writes commands that make and use them into a buffer, and
  hands the buffer to the host once a frame; the host carries the
  commands out one for one on the WebGPU API and submits the frame.
  The commands cover what a 2D or a 3D renderer needs: render passes
  with several colour targets and a depth attachment, compute passes,
  explicit layouts with dynamic offsets, culling, blending, instanced
  and indexed draws, textures from files, writing and reading buffers
  and textures. WebGPU reports most mistakes later, and reading data
  back takes time, so those arrive as events: the host calls the
  program's `on-gpu` for an error (a shader that does not compile, a
  draw with a buffer that is too small), a texture file that arrived,
  and pixels or bytes read back. A mistake in the commands themselves
  stops the program, as a bad patch does. `lib/web/gpu.sub` writes the
  commands from a program, and checks that a command's lists are
  complete before the next one. `tests/web/gpu.sub` is the module used
  directly: a pipeline of the program's own drawing into a texture, a
  compute shader doubling numbers, and a shader with a mistake, each
  read back.
  - Renderers are libraries in the program's language. The first is
    `lib/web/game/sprites.sub`: a frame's sprites and rectangles are
    gathered into a batch, in order, and drawn with one upload and one
    draw call per run of sprites from the same sheet. The vertex
    shader makes each sprite's two triangles and finds its cell in the
    sheet; a bind group per sheet gives the shader the texture. A game
    gets it with `[renderer gpu]` (`game.sub`); the game's text is
    drawn by the 2D context on a see-through canvas over the screen.
    The platformer runs this way.
  - What it costs (`tests/web/sprites.mjs`; the table below). On the
    processor, a frame of 20,000 sprites takes the program 0.45 ms,
    where the 2D context takes 42 ms. On the development machine's
    GPU, 200,000 sprites are 2.7 ms in the program and 5.7 ms on the
    GPU, at 60 frames a second.
  - The headless browser of the tests has no GPU. It runs WebGPU on
    SwiftShader with the flags `webgpuFlags` in `host/web/browser.mjs`
    and its GPU process on; with the process off it destroys the
    device as soon as a canvas is drawn on. On macOS, where every
    machine has a GPU and Chromium's WebGPU runs on Metal, the flags
    only turn WebGPU on, since SwiftShader's device is lost there as
    soon as it is used. The machine's own GPU can
    be used with `hardwareGpuFlags`, but then the browser cannot
    present a canvas, so the module has an off-screen mode in which a
    surface is a texture; `sprites.mjs hardware` measures that way.
    What a WebGPU canvas shows cannot be read back through a 2D
    context in either browser, so the module has `readSurface`, which
    copies the next frame drawn on a surface for a test
    (`tests/web/pages.mjs`: `gpu`, `platformer`, `sprites`).
  - The 3D side (`lib/web/game/meshes.sub`, `voxels.sub`, `math.sub`).
    A mesh is textured triangles the program builds; the renderer
    draws every mesh from a camera, with a depth texture, back faces
    culled, and fog, and the meshes' origins come from one uniform
    buffer through dynamic offsets. `voxels.sub` builds meshes for a
    world of blocks (each face of a block that touches air, with
    lighting baked into the vertices: tops bright, undersides dark, and
    corners that are closed in darker), and gives the world its
    bodies and its line of sight. `math.sub` has what the camera needs
    and wasm does not provide: sin, cos, and 4 by 4 matrices. A game
    draws its scene first, then its sprites and text, which go on top.
    The blocks example (below) is all this in use.
  - Not done: lines, circles and paths on the GPU (a game that needs
    them uses the canvas renderer), and the swap of the overlay canvas
    for text drawn by the GPU.
- **Guests** (`host/web/guest.mjs`, `lib/web/guest.sub`): running code that is
  not trusted. A program can start another program as a "guest": a
  separate sandbox with its own memory. The two share nothing, and they
  communicate only by messages, which are bytes that the host copies.
  The first program decides what the guest gets: its program, its
  arguments, the directories it may read and write, a time limit for
  each message, and a memory limit. It can stop the guest at any time,
  even in the middle of an infinite loop, and it is told when the guest
  prints, sends a message, finishes handling a message, crashes or
  exits. In a browser a guest is a Web Worker, so it also runs in
  parallel with the page. The interface itself does not depend on
  workers: a host with a single thread could run a guest between the
  main program's events, and stop it with an instruction budget. Only
  the browser host implements guests so far.

### The REPL page

`lib/web/repl` is two programs. `repl.sub` is the page: the user interface,
39 KB when compiled. `session.sub` is the compiler with a session
(460 KB), which the page runs as a guest. Each input is sent to the
guest, which compiles and runs it and sends back the result.

Because the user's code runs in the guest, it cannot harm the page:

- An input that loops forever leaves the page responsive, and a Stop
  button kills the guest.
- An input that corrupts memory, which is possible in the C-like Lisp,
  breaks only the guest. The page notices that the guest has stopped
  answering, and replaces it.
- When a guest is replaced, the page sends the new one every input that
  had succeeded, so the new session has the same definitions as the old
  one.

### The snake example

`lib/web/examples/snake` is a small complete game, and shows how the
pieces fit together. The game itself (`rules.sub`) knows nothing about
pages. It is a struct and a few functions: start a game, turn, and
advance to a given time. It has its own timing, which turns the
browser's uneven frames into steps of a fixed length, so the snake
moves at the same speed on every screen. Because it needs no browser,
it is tested by a scripted game with made-up times, which prints the
board as text (`tests/ui/snake.sub`). The page (`snake.sub`) is the
usual model, messages, update and view. Its canvas has a frame
listener and a key listener; `update` passes frames and keys on to
the game; and the board is drawn again whenever a counter in the
model changes. The compiled program is 33 KB.

```sh
lib/web/site.sh lib/web/examples/snake/snake.sub build/web/snake lib/web/examples/snake/page.html
host/web/serve.mjs build/web/snake
```

### The platformer example

`lib/web/examples/platformer` is a small platform game built on the game
library: run, jump, collect coins, jump on enemies, avoid spikes and
pits, reach the flag, which leads to the next level. The game is one
file, `world.sub`: the rules and the drawing. `platformer.sub` is one
line that hands its three functions to the game loop.

The levels are text files among the game's assets
(`assets/levels/1.txt`, `2.txt`, and so on), drawn with characters:
`#` for ground, `o` for a coin, `E` for an enemy. After each flag the
game loads the level with the next number, and it is won when there
is no such file. So a level is changed, or one is added, by editing a
text file; nothing is compiled.

The coins and the enemies are kept in stores (`game/store.sub`). What
happens later is done with timers that carry messages
(`game/timers.sub`): a flattened enemy disappears after half a second,
the level starts again a moment after the player died, and the next
level starts a second after the flag.

The other asset is `assets/sprites.png`: a sheet of sprites of 16 by
16 pixels. The directory `art/` is not part of the game. It records
how this image was drawn: as text, in `art.txt`, with one character
per pixel, which `make-sprites.mjs` turns into the PNG. An image
editor would do as well.

The game is tested without a browser (`tests/ui/platformer.sub`): a
bot holds the right arrow and jumps when a wall, a hole, spikes or an
enemy is ahead, and must finish both levels. Since the game has no
randomness and takes fixed steps, the run is the same every time. The
compiled program is 74 KB, and its assets under 3 KB.

```sh
lib/web/site.sh lib/web/examples/platformer/platformer.sub build/web/platformer lib/web/examples/platformer/page.html
host/web/serve.mjs build/web/platformer
```

Arrows (or A and D) run, Space (or the up arrow, or W) jumps.

### The blocks example

`lib/web/examples/blocks` is a world of blocks in 3D, built on the game
library's 3D side: hills of grass over dirt over stone, sand in the low
places, trees, 64 blocks wide and deep and 32 high, made from noise
with a fixed seed. The player walks and jumps through it, looks
around, removes the block in front of them and places blocks of six
kinds. Nothing is won or lost; it is the 3D counterpart of the
platformer. The game is one file, `world.sub`; `blocks.sub` is one
line that hands its three functions to the game loop, with
`[renderer gpu]`, since a scene needs the GPU.

The world is a grid (`game/voxels.sub`) drawn in chunks of 16 by 32 by
16 blocks, each a mesh (`game/meshes.sub`); a chunk is built again
when a block in it changes, and so is a neighbouring chunk when the
block is at their boundary. The player is a body that the grid stops
(`move-body!`), and a step one block high is jumped over by itself
when there is room above it (`body-free?`). What the player looks at
is the first block a ray from the eye meets (`ray-hit!`), with the
face it entered through, which is where a placed block goes. The
camera is a yaw and a pitch (`game/math.sub`), turned by the arrow
keys or, once a click has locked the pointer to the screen, by the
mouse, whose buttons then dig and place.

The asset is `assets/atlas.png`, a row of eight tiles of 16 by 16
pixels, one for each face kind. `art/make-atlas.mjs` draws them from
a few colours and seeded noise; like the platformer's `art/`, it is
not part of the game.

The game is tested without a browser (`tests/ui/blocks.sub`): the
world is made, the player falls, walks, jumps, looks down, digs and
builds by made-up key presses and mouse movements, and a tree put in
the way stops them. The browser test reads the GPU's picture: sky at
the top, land at the bottom, a view that changes when walking and when
digging, and, after a click has locked the pointer, when the mouse
moves and its button digs. The compiled program is 120 KB, and its
asset 3 KB.

```sh
lib/web/site.sh lib/web/examples/blocks/blocks.sub build/web/blocks lib/web/examples/blocks/page.html
host/web/serve.mjs build/web/blocks
```

Click the screen to look around with the mouse (Escape frees it); W,
A, S and D walk, the arrows also turn and look, Space jumps, the left
button or X digs, the right button or C places, 1 to 6 choose what to
place.

### Measurements

In headless Chromium, on the development machine:

| The REPL | |
|---|---|
| The page is ready | 80 ms |
| Starting a guest that contains the compiler | 20 ms |
| The first input of a session, which compiles Substrate from source | 210 ms |
| A later input, from sending it to receiving the reply | 0.4 ms |
| Stopping a looping guest and restoring a session of 23 inputs | 100 ms |

| The rows example (`lib/web/examples/rows.sub`) | |
|---|---|
| Create 1,000 rows | 20 ms |
| Create 10,000 rows | 210 ms |
| Select one row of 10,000 (every row is checked for changes) | 0.5 ms |
| Swap two rows of 1,000 | 1 ms |
| Remove one row of 1,000 | 0.9 ms |

| Canvas | |
|---|---|
| Draw 10,000 rectangles in one frame | 2 ms |
| One frame of snake, including drawing the board | under 0.1 ms |
| One frame of the platformer: a step, and about 70 sprites drawn | under 0.1 ms |

| The blocks example (GPU) | |
|---|---|
| Making the world and the meshes of its 16 chunks (16,360 faces), on the first frame | 14 ms |
| A frame: a step, and the 16 meshes drawn, in the program | 0.1 ms |
| The same frame on the GPU, from hand-over until done: RTX 5090 / SwiftShader | 0.6 ms / 3.8 ms |

| Sprites, the two renderers (`tests/web/sprites.mjs`) | 2D context | WebGPU, the program | WebGPU, the GPU |
|---|---|---|---|
| 1,000 sprites: a frame | 0.75 ms | 0.08 ms | 1.1 ms |
| 5,000 sprites | 8.8 ms | 0.17 ms | 2.2 ms |
| 20,000 sprites | 42 ms (22 frames a second) | 0.45 ms | 2.2 ms |
| 100,000 sprites | | 1.5 ms | 3.9 ms |
| 200,000 sprites | | 2.7 ms | 5.7 ms |

The 2D context draws in software in the headless browser; its time is
the drawing. The WebGPU renderer's time in the program is building the
frame and handing it over, after which the GPU draws it: the last
column is the development machine's GPU (an RTX 5090, drawing off
screen), from the hand-over until it was done. SwiftShader, which
stands in for a GPU in the test browser, takes 12 ms, 150 ms and 600 ms
for the first three frames instead.

The rows are timed by `tests/web/rows.mjs`, from the click until the
browser has laid the page out again.

## History

The compiler was first written in Substrate, over a kernel module whose
data were wasm GC objects, and built by stage0, a compiler written apart
in Chez Scheme, which wrote the same bytes; stage0 was retired after
commit 3e74bce. The compiler in the C-like Lisp was then written beside
it as an experiment, `next/`, ported from it file by file, built its
first stage with it, and replaced it: both stay in the history. Its
plan, and what each step found:

1. Syntax objects, then the reader. Done: the reader reads the compiler's
   and the libraries' files as `compiler/reader.sub` does, datum for
   datum and location for location.
2. The expander, compiling to wasm, and compile-time code and phases.
   The kernel's tests are the check. Done: every file of the repository
   whose meaning the compiler keeps, the kernel's tests among them,
   it expands and builds as the compiler does, byte for byte, its errors
   and what compile-time code prints included; and the kernel's tests of
   compile-time code, in the new kernel module (`tests/`), give their
   tests' output.
3. `syntax-match`, from `lib/substrate.sub`'s patterns, on the kernel
   module's syntax objects. Done: `compiler/syntax-match.sub`, in kernel code,
   gives the kernel's tests of it, ported to `tests/`, their output:
   `tests/syntax-match.sub`'s, and its error tests' messages.
4. The C-like Lisp, until then an example of a language on the kernel
   (`examples/c/lang.sub`, now `compiler/base/`), as macros on the kernel
   module, written in kernel code, as `lib/substrate-core.sub` writes
   Substrate's, with its run-time part in the kernel module; then the C
   example's tests, and the compiler compiling itself, to a fixpoint,
   the current build its first stage. Done: `c/lang.sub` has its
   transformers in kernel code; the C example's tests, in `tests/base`,
   give their outputs and errors on it; the compiler's sources are
   written in it, `kernel.sub`'s own macros in kernel code; and the
   build the compiler made of them built them into a compiler that
   builds itself into the same bytes, the seed.
5. Substrate and Bend on the C-like Lisp, which is the base language:
   the kernel's specification is what code compiles to, and C is what it
   is written in, with the kernel's instructions in `func` bodies.
   Macros are written in C, and need no GC; Substrate's values were wasm
   GC objects, its run time in `func` bodies, until 6 gave it values of
   its own. In order:
   1. C as a language for macros: quoted data and syntax in C code, and
      `syntax-match` for C. Done: `tests/c-macros.sub`,
      `tests/c-quote.sub`, and `tests/base/syntax-match.sub`, the kernel's
      test of `syntax-match` in C, which gives its output.
   2. Substrate's data, the old kernel module's GC data but syntax, and
      its literals, made when a module starts. Done: `substrate/data.sub`
      (`tests/substrate/data.sub`), since replaced by `values.sub` (6).
   3. Substrate's forms, and pattern macros for Substrate's users. Done:
      `substrate/core.sub` and `substrate/substrate.sub`; the Substrate
      tests of `tests/` give their outputs on them (`tests/substrate`),
      their macros written with `syntax-rules`; both now on the values
      of 6.
   4. Bend, its checker first-order, in C, compiling to linear memory.
      Done: `lib/bend/`; the Bend tests of `tests/` (`tests/bend`) and
      the Bend example (`tests/bend/example.sub`) give their outputs
      and errors on it. Bend2's `proofs_3200` benchmark, checked and
      compiled, builds in 2.9 s on V8 and 3.3 s natively, where the
      example takes 12.7 s.
   5. Numeric instructions and reference types in C code; then the typed
      example.
6. Substrate on its own values, `lib/substrate/` as it is now: Substrate's
   values nodes in the program's memory, owned and freed by the program,
   so that a program needs no GC, with the kernel module as it is and
   Substrate not running at compile time: its macros are written in the
   C-like Lisp, as they were on the GC values, or with `syntax-rules`. The way there
   was an experiment, Substrate on cells, which made Substrate's values
   the kernel module's cells so that its data at compile time was the
   kernel module's, syntax objects included, and its macros could be
   written in Substrate again: it worked, the Substrate tests and a
   type checker written in Substrate as a macro passed on it, but it
   put a facility of owners, a heap beside the arenas, and a hold on
   what a macro gives the expander into the kernel module, two worlds
   in one kind of cell, for the sake of a macro language the C-like
   Lisp already serves (`compiler/base/forms.sub`); so the kernel module was made
   an arena's again, and Substrate given values of its own. What the
   experiment found stays: the lowering that owns each value
   (`lower.sub`), from it.

   `values.sub` is the data, in the C-like Lisp: a datum is an i32, a
   fixnum odd, a character its code shifted with 10 below, #f 0, and
   anything else the address of a node, a multiple of 4, whose first
   word holds its tag in the low byte and its count of owners above,
   the count 2^24 - 1 marking it permanent: nil, #t, every symbol and
   keyword, which are interned, and a module's quoted data. A pair is
   three words; a string, integer, flonum, symbol or keyword a node of
   its own; a closure, box, vector, byte string, struct type, struct,
   hash table, port or exception a node of the runtime's kind
   (`runtime.sub`), whose layout the runtime registers so that the drop
   loop frees it, or whose dropper it does. Nodes come from a free list
   per size up to 64 bytes, filled from chunks past the C heap, and go
   back to it; `dup` adds an owner, `drop` takes one away and at the
   last frees the node and what it holds, a list cdr by cdr and anything
   else through an explicit stack, a pair whose fields need nothing
   freed inline where it is dropped. `quote` makes a module's quoted
   data once, as the module starts, in a C global marked permanent and a
   kernel global holding the same value, so a literal in compiled code
   is a global.get that the lowering knows needs no counting; `lit` is
   the same for C code. The lowering (`lower.sub`) is the experiment's,
   naming `values.sub`'s inline functions: a function owns its
   parameters, unless `core.sub` marks them `#:borrow` or the pass finds
   it only reads them, and what it returns; the last use of a variable
   moves its value, an earlier use dups it, a variable never used is
   dropped where it is bound, a branch drops what only the other branch
   uses, `set!` drops what it replaces; a local function that is only
   called is a kernel function of the variables it captures, called
   directly; a pair whose owner's last use projects it is taken apart
   and its node reused, as Perceus does; `car` and `cdr` of a variable
   that holds its value, borrowed or owned, given to a function that
   only reads them are read where they are, the variable kept through
   the call; and what a function of the runtime's or `values.sub`'s
   gives and takes, the pass reads from facts. After each check of
   `tests/substrate/live-nodes.sub` no more nodes are in use than before
   it; the tests of Substrate at compile time, and the typed example,
   are gone with it.

   Its speed, against the cells experiment and the GC values on V8, each program run twice and the second taken, on this machine
   (the GC versions take 0.08 s to start): over 30 M iterations, on
   wasmtime, fixnum arithmetic takes 0.20 s on owned values against
   0.21 on cells and 0.33 with GC on V8, walking a list 0.16 against
   0.15 and 0.20, making and freeing pairs 0.26 against 0.31 and 0.28,
   and 10 M closure calls 0.14 against 0.15 and 0.14; the list
   benchmark 0.21 against 0.23 and 0.19, the one of closures, structs
   and a hash table 0.13 against 0.14 and 0.11; on V8 the owned
   versions take 0.19, 0.17, 0.26, 0.15, 0.21 and 0.15 s. The untuned
   programs: the interpreter 0.51 s on wasmtime and 0.39 on V8, against
   0.57 and 0.45 on cells and 0.29 with GC; N-queens 0.27 and 0.26
   against 0.29 and 0.29, and 0.21; the string program 0.14 and 0.18
   against 0.18 and 0.21, and 0.17. So owned values are at or ahead of
   cells everywhere, ahead of V8's GC on arithmetic, walking, pairs and
   calls, and behind it where a program makes and frees many short-lived
   pairs, closures and environments: freeing them one by one, through
   `free-node!`, is a tenth of the interpreter's time, which the GC's
   nursery never pays for garbage. The Bend checker written in Substrate
   ran as macros, Substrate at compile time, which this design does not
   run: Bend on the compiler is `lib/bend/`, in the C-like Lisp. Next: a
   closure given to a call that does not keep it, which the facts could
   tell, made on the stack rather than freed; and what still leaks: a
   value a raise unwinds past, and a closure that refers to itself
   through a box, as a letrec's that escapes does.
7. Sessions and web pages, from the web-repl branch, which did its work
   on the compiler while it was `next/`, merged once `next/` was
   promoted: a session (`compiler/expander.sub`), the browser host
   (`host/web/`) and the web libraries (`lib/web/`), as "Sessions" and
   "Web pages" above describe. Still to do in the C-like Lisp: the
   exact line of a trap inside an instance of another module's generic
   function. The instance is located at the generic's definition, but
   the lines within it are not reported, because the compiler replaces
   a location from another file by the nearest enclosing one (spec
   3.6). An instance's own file should count as its file: a change to
   the compiler's back end and to the spec.
