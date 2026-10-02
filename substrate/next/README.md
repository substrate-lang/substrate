# next

An experiment: the compiler written in a C-like Lisp, the C example's
(`examples/c`) as the new compiler builds it (`c/`), so that reading,
expanding and compiling need no GC. It is ported from `compiler/` file by
file. It builds itself, from a seed, as the compiler does; the compiler
built its first stage, and nothing in `compiler/` or `lib/` changes for
it. The JavaScript host in `host/` is split into a shared core and a
part for Node, so that a web page can run programs too (see "Web
pages" below).

The stack it aims at is the wasm kernel, then a C-like Lisp, then
Substrate as a library on it, able to drop into it, then Bend. Syntax
objects live in the compiler's memory, and the macros of every layer work
on them there.

## Layout

- `compiler/`, the new compiler, its files after `compiler/`'s:
  - `kernel.sub`: the kernel module (below): `compiler/kernel.sub`, with
    its data, syntax objects among them, in memory; and what
    `compiler/stx.sub` has on them.
  - `numbers.sub`: `compiler/numbers.sub`, with the reading and writing of
    decimals that the old compiler takes from Substrate.
  - `host.sub`: `compiler/host.sub`, with reading and writing files.
  - `reader.sub`: `compiler/reader.sub`.
  - `core.sub`: `compiler/core.sub`, with its infos as C structs, each
    with a record, a datum, that stands for it in lowered code.
  - `ops.sub`: `compiler/ops.sub`.
  - `expander.sub`: `compiler/expander.sub`, with its cache and compiled
    files (spec 3.7), whose interfaces are of the running compiler, by
    the names of its build's linklets, which carry the hashes of its
    modules, where the compiler's are of its kernel: a change to how the
    new compiler compiles is not hidden by modules an earlier build
    compiled. A require's path is relative to the file the path is
    written in, so a require a macro makes names a file from the macro's
    own, where the compiler's names one from the module it expands.
  - `running.sub`: the build that runs the compiler, as the compiler
    reads it: its program's list of linklets, and a linklet's exports and
    imports.
  - `leb128.sub`, `wasm.sub`, `closures.sub`, `serialize.sub` and
    `compile.sub`: the compiler's, into buffers and arenas.
  - `main.sub`: `compiler/main.sub`, with its `build` (`-m` included),
    `compile` and `expand` commands, and its cache, `-c DIR`; and `eval`,
    which runs a file as a session: its top-level forms are compiled and
    run one at a time (see "Sessions" below).
- `c/`: the C-like Lisp, `examples/c` as the new compiler builds it,
  which the compiler's sources are written in:
  - `lang.sub`: `examples/c/lang.sub`, its transformers in kernel code,
    function for function. C code quotes data and syntax (`'d`, `#'x`),
    typed as the kernel module's `datum`, as the module of the function
    or global that quotes it names it, with `kernel.sub`'s templates
    `` `t `` and `` #`t ``.
  - `runtime.sub`, `math.sub` and `c.sub`: `examples/c`'s.
  - `syntax-match.sub`: `lib/substrate.sub`'s patterns for syntax, in
    kernel code, on the kernel module's syntax objects, its code kernel
    code; `c-syntax-match.sub`, the same, its code C, for macros written
    in C; `patterns.sub`, what the two share: the pattern words, the
    parser and the error when no clause matches.
  - `kernel-forms.sub`: forms that kernel code is written with, `cond`,
    `and`, `or`, `when`, `unless` and `case`, and Racket's `for` forms on
    lists, its `for` named `for/each`, as `lib/substrate-core.sub` gives
    Substrate its forms.
- `substrate/`: Substrate as the new compiler builds it, on the C-like
  Lisp (plan, 5):
  - `data.sub`: its data, `compiler/kernel.sub`'s but for its syntax
    objects, as wasm GC objects; its `quote`, which makes a datum as its
    value, once, when the module that quotes it starts; and its
    `quasiquote`.
  - `core.sub`: `lib/substrate-core.sub`, its transformers kernel code on
    the kernel module's data, its run-time functions on `data.sub`'s.
  - `substrate.sub`: `lib/substrate.sub`, its forms and `match` written
    in C. A module written in Substrate defines macros with patterns,
    `syntax-rules`, which compile into C at its phase 1, not with
    Substrate code: Substrate does not run at compile time, and has no
    syntax objects among its values.
- `bend/`: Bend as the new compiler builds it, `examples/bend` ported to
  the C-like Lisp (plan, 5):
  - `core.sub`: `examples/bend/core.sub`, the checker, function for
    function, its terms variants in arenas and its binders' bodies data,
    where the example's are Substrate closures; a definition is checked
    in an arena of its own, freed when it is done, and a template's
    instance, checked while the definition that applies it is read, in
    one of its own above it.
  - `bend.sub`: `examples/bend/bend.sub`'s forms, templates and `print`
    among them, which read a term from its syntax, where the example
    expands it and reads the expansion back; a definition's fact holds its
    terms as bytes and the names they refer to, and the name of its
    function, which is made as soon as the definition is checked.
  - `lower.sub`: `examples/bend/lower.sub`, the code of definitions and
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
  - `base.sub`: `examples/bend/base.sub`.
- `web/`: libraries and examples for programs that run in a web page
  (see "Web pages" below):
  - `ui.sub`: a template language for pages ("views"), built on the
    C-like Lisp.
  - `web.sub`: the structure of a page's program (model, messages,
    update, view) and its connection to the browser.
  - `canvas.sub`: drawing on a `<canvas>` element: rectangles, paths,
    circles, text, and sprites from image files.
  - `files.sub`: reading and writing files, which works on every host.
  - `guest.sub`: functions for running another program in a sandbox (a
    "guest"), on hosts that support it.
  - `game/`: a small library for 2D games:
    - `game.sub`: the game loop. `(game World [size 320 180] init step
      draw)` turns three functions into a game in a page.
    - `input.sub`: which keys are held, and which were just pressed.
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
    files, and its sheet of sprites.
  - `repl/`: the REPL page. `repl.sub` is the page's program (the user
    interface); `session.sub` is the compiler, which the page runs in a
    sandbox; `page.html` and `site.sh` make the site.
- `seed/`: a build of the new compiler by itself, checked in, as `seed/`
  is the compiler's.
- `sub`: runs the new compiler as `bin/sub` runs the compiler, keeping
  compiled modules in `build/next/cache`; when its sources changed, it
  first builds them with the seed, and them again with that build, into
  `build/next/sub`: `next/sub build FILE`.
- `bootstrap.sh`: the fixpoint: `build/next/sub` builds itself into the
  same bytes; `next/bootstrap.sh seed` then makes it the seed.
- `compare.sh`: every `.sub` file of the repository expanded, or built,
  by both compilers, which must give the same, a program's linklets byte
  for byte, but where the new compiler differs by design.
- `tests/`: the new compiler's own tests, which it builds (`run.sh`): the
  kernel's tests of compile-time code and of `syntax-match`, on the new
  kernel module; the C example's tests (`tests/c`), on `c/`; the
  Substrate tests of `tests/`
  (`tests/substrate`), on `substrate/`, with
  their outputs, but for those of Substrate's syntax objects and its code
  at compile time; the Bend tests of `tests/` and `examples/bend.sub`
  (`tests/bend`), on `bend/`; and the tests of its parts: its syntax
  objects, its reader, and what its expander and back end give for the
  kernel's tests, which is what the compiler gives. `tests/ui` tests
  the page views (`web/ui.sub`): the tests print the page changes that
  a view produces, and check the error messages for templates that are
  wrong. They also test reading files (`web/files.sub`) and the game
  library (collision, keys, timers, sound, its containers and its
  formatting), and play the two example games without their pages: the
  platformer is played by a bot that presses the keys.
  `tests/session` tests sessions: `next/sub eval` runs each
  file, one form at a time. `tests/web/run.sh` is separate, and runs
  the tests that need a browser: the session tests again, with the
  compiler running in a page, and the pages of `web/`.
  Then, as `tests/run.sh` checks the
  compiler's, the cache: every program built again from it is byte for
  byte the same, and a stale entry is not used; and `compiled-import.sub`
  requires a compiled file.

## The kernel module

The kernel module (spec 1.2) holds the data of every language built on
the kernel, syntax objects among them, and the functions of the macro
contract (spec 2). The old compiler's, `compiler/kernel.sub`, has them as
GC objects; the new compiler's is `kernel.sub`, with the data in memory,
with the run-time modules it rests on, which give it its memory and
allocator: `lib/print.sub`'s memory, and `c/`'s `sbrk`, stack and
allocator. The GC kernel module is not part of the new compiler: the
kernel language keeps wasm's GC types and instructions, and a language
that wants GC data, as Substrate will, defines its own.

- **Data** are `i32`s, the addresses of `kernel.sub`'s cells, which macros
  make and take apart with its functions, the old kernel module's under
  their names but for `integer` and `flonum`, which are `make-integer` and
  `make-flonum`, and its string builders, which are `lib/print.sub`'s
  buffers. `quote`, `quasiquote`, `quote-syntax` and `quasisyntax` make
  them: a linklet's quoted data is serialized into a data segment, which
  `kernel.sub` reads into the current arena when the linklet starts,
  mapping a syntax object's scopes to the run's (spec 3.5); so a linklet
  that quotes data, at any phase, has the kernel module's memory for its
  own.
- **A syntax error** is `kernel.sub`'s `compile-error` exception, which
  holds the message, the syntax blamed and a source location, where the
  old kernel module throws a syntax error value with its `exn` tag.
- **Compile-time code** links to the running compiler's instances of the
  kernel module, as the old compiler's links to its running kernel's
  (spec 1.4), so the compiler and every macro share its data, memory and
  allocator: the kernel module's whole group, `kernel.sub` and the
  run-time modules it rests on, at any phase shift, whether a module
  requires it as `kernel` or requires them by path. So a macro can be
  written in the C-like Lisp, a C function at phase 1 on the kernel
  module's data (`tests/c-macros.sub`), as well as in kernel code.
  `(require k kernel)` binds `kernel.sub`'s functions and tags,
  at any phase, and `(memory from k)` and `(table from k)` take its
  memory and table; a linklet at phase 1 or above that declares none
  takes them too. The compiler is given the directory of the build that
  runs it (`-r DIR`, which `next/sub` passes), whose program lists the
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

The new compiler adds to the kernel language, for code it compiles
better: `(values e ...)`, several values, and a `let` binding of them,
`[(x ...) init]` or `[(x ...) (type ...) init]`, so that a function of
several results can be called for them (`tests/let-values.sub`); and
`(br-table (label ...) default index)`, a branch to the label a number
says, as wasm's `br_table` is, so that a switch is one jump
(`tests/br-table.sub`).

Code written for the old compiler's kernel module, its GC data and
syntax objects, `lib/` among it, does not run on the new compiler:
Substrate is built again in `substrate/` (plan, 5).

## Sessions

A session compiles and runs code one piece at a time, as a REPL does. It
is part of the compiler (`compiler/expander.sub`, the "sessions"
section).

```sh
next/sub eval FILE    # run FILE's top-level forms one at a time, as a session
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
  whatever the inputs `require`. `(require-unqualified c ".../c.sub")`
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

A program can run in a browser and draw a web page. `web/` has the
libraries for this, and `host/web` has the JavaScript that runs a
compiled program in a page. The demonstration is `web/repl`, a REPL in
which everything that is typed is compiled and run in the browser.

```sh
next/web/repl/site.sh build/next/web/repl    # build the REPL's web site
host/web/serve.mjs build/next/web/repl       # serve it, and open the address it prints
next/web/site.sh FILE OUT                    # build the site of another program
next/tests/web/run.sh                        # run the browser tests (headless Chromium)
```

A site is made of static files only, so any web server can serve it.

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
  permissions. There are three: `dom` (`host/web/dom.mjs`), for drawing
  on the page; `audio` (`host/web/audio.mjs`), for sound; and
  `guest` (`host/web/guest.mjs`), for running other programs in a
  sandbox. The compiler is run with no extra modules, so
  code that runs at compile time cannot use them, and builds stay
  reproducible (spec 4).
- **Views** (`web/ui.sub`): a template language for pages, built on the
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
  browser, by printing the patches (`tests/ui`, `web/trace.sub`).
- **Program structure** (`web/web.sub`): a model (all of the program's
  state), a message type (everything that can happen), an `update`
  function, and a view. The design is Elm's. An event listener in a
  template names the message to send, and the message can carry data
  from the event, such as `(event value)` for the text of a field.
  Messages are data rather than callbacks, because the C-like Lisp's
  closures cannot be stored. Things that happen outside the page, such
  as a reply from a guest, are turned into messages with `send!`.
  `web/examples/counter.sub` is a minimal example; its compiled program
  is 20 KB.
- **Canvas** (`web/canvas.sub`): drawing with code instead of with
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
  (`web/files.sub`): `site.sh` writes their names in `assets.list`, and
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
- **The game library** (`web/game/`). A page program is driven by
  messages, which suits a user interface. A game is easier to write as
  a loop: sixty times a second, look at the keys and move everything;
  then draw. `(game World [size 320 180] init step draw)` provides that
  loop. It calls `step` at a steady rate whatever the screen's refresh
  rate, hands it the state of the keyboard (which keys are held, and
  which were pressed since the last step), plays the sounds the game
  asked for, and draws every frame on a canvas of exactly the size
  given, which the browser stretches to the window without blurring.
  It is a macro that expands into an ordinary page program.
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
- **Guests** (`host/web/guest.mjs`, `web/guest.sub`): running code that is
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

`web/repl` is two programs. `repl.sub` is the page: the user interface,
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

`web/examples/snake` is a small complete game, and shows how the
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
next/web/site.sh next/web/examples/snake/snake.sub build/next/web/snake next/web/examples/snake/page.html
host/web/serve.mjs build/next/web/snake
```

### The platformer example

`web/examples/platformer` is a small platform game built on the game
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
next/web/site.sh next/web/examples/platformer/platformer.sub build/next/web/platformer next/web/examples/platformer/page.html
host/web/serve.mjs build/next/web/platformer
```

Arrows (or A and D) run, Space (or the up arrow, or W) jumps.

### Measurements

In headless Chromium, on the development machine:

| The REPL | |
|---|---|
| The page is ready | 80 ms |
| Starting a guest that contains the compiler | 20 ms |
| The first input of a session, which compiles Substrate from source | 210 ms |
| A later input, from sending it to receiving the reply | 0.4 ms |
| Stopping a looping guest and restoring a session of 23 inputs | 100 ms |

| The rows example (`web/examples/rows.sub`) | |
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

The rows are timed by `tests/web/rows.mjs`, from the click until the
browser has laid the page out again.

## Plan

1. Syntax objects, then the reader. Done: the reader reads the compiler's
   and the libraries' files as `compiler/reader.sub` does, datum for
   datum and location for location.
2. The expander, compiling to wasm, and compile-time code and phases.
   The kernel's tests are the check. Done: every file of the repository
   whose meaning the new compiler keeps, the kernel's tests among them,
   it expands and builds as the compiler does, byte for byte, its errors
   and what compile-time code prints included; and the kernel's tests of
   compile-time code, in the new kernel module (`tests/`), give their
   tests' output.
3. `syntax-match`, from `lib/substrate.sub`'s patterns, on the kernel
   module's syntax objects. Done: `c/syntax-match.sub`, in kernel code,
   gives the kernel's tests of it, ported to `tests/`, their output:
   `tests/syntax-match.sub`'s, and its error tests' messages.
4. The C-like Lisp, `examples/c/lang.sub`, as macros on the kernel
   module, written in kernel code, as `lib/substrate-core.sub` writes
   Substrate's, with its run-time part in the kernel module; then the C
   example's tests, and the compiler compiling itself, to a fixpoint,
   the current build its first stage. Done: `c/lang.sub` has its
   transformers in kernel code; the C example's tests, in `tests/c`,
   give their outputs and errors on it; the compiler's sources are
   written in it, `kernel.sub`'s own macros in kernel code; and the
   build the compiler made of them built them into a compiler that
   builds itself into the same bytes, the seed.
5. Substrate and Bend on the C-like Lisp, which is the base language:
   the kernel's specification is what code compiles to, and C is what it
   is written in, with the kernel's instructions in `func` bodies.
   Macros are written in C, and need no GC; Substrate's values are wasm
   GC objects, its run time in `func` bodies. In order:
   1. C as a language for macros: quoted data and syntax in C code, and
      `syntax-match` for C. Done: `tests/c-macros.sub`,
      `tests/c-quote.sub`, and `tests/c/syntax-match.sub`, the kernel's
      test of `syntax-match` in C, which gives its output.
   2. Substrate's data, the old kernel module's GC data but syntax, and
      its literals, made when a module starts. Done: `substrate/data.sub`
      (`tests/substrate/data.sub`).
   3. Substrate's forms, and pattern macros for Substrate's users. Done:
      `substrate/core.sub` and `substrate/substrate.sub`; the Substrate
      tests of `tests/` give their outputs on them (`tests/substrate`),
      their macros written with `syntax-rules`.
   4. Bend, its checker first-order, in C, compiling to linear memory.
      Done: `bend/`; the Bend tests of `tests/` (`tests/bend`) and
      `examples/bend.sub` (`tests/bend/example.sub`) give their outputs
      and errors on it. Bend2's `proofs_3200` benchmark, checked and
      compiled, builds in 2.9 s on V8 and 3.3 s natively, where the
      example takes 12.7 s.
   5. Numeric instructions and reference types in C code; then the typed
      example.
