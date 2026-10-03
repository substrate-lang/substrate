# Substrate kernel specification (v0 draft)

Substrate is a Lisp over WebAssembly. This document specifies its kernel.
The kernel's one real addition to wasm is compile-time execution: macros
are ordinary kernel code, compiled to wasm and run by the same engine
that runs programs. The aim is that different languages can be built as
libraries over one small kernel, and that the code they produce carries
no runtime it did not ask for. The language most code is written in, also
called Substrate, is one such library (`lib/substrate/`), as `racket/base`
is built over Racket's `#%kernel`.

The kernel has three parts:

- its forms (section 5), which the compiler implements;
- the **kernel module** (section 2): the data every language builds on,
  syntax objects among them, and the functions on that data. The compiler
  shares it with its macros, and carries it into the programs that use
  its data;
- the host interface (section 4).

Kernel code is code written in the kernel's forms.

## 1. Principles and architecture

### 1.1 Principles

1. **The kernel is wasm with names, plus compile-time execution.** "Wasm"
   is Wasm 3.0, including reference types, GC and exception handling. The
   kernel language adds no memory model and no runtime of its own. The
   kernel module is a library, in linear memory, that compile-time code
   and programs use when they need its data.
2. **Pay as you go.** Compiled code contains only what its code uses. A
   module can declare that it needs nothing beyond the host at run time,
   and the compiler checks the declaration after expansion (3.4).
3. **Phases are uniform.** The language is the same at every phase. Code
   requires the libraries it uses, at the phase that uses them, and each
   phase gets its own instances.
4. **Syntax belongs to the expander.** Macros create and inspect syntax
   only through the kernel module's functions (section 2). At compile
   time they link to the running compiler's own instance of that module
   (1.4). So adding a function to the kernel module adds to the kernel, as
   adding a form does: compile-time code can use the function once the
   compiler that runs the code has it.
5. **The compiler is an ordinary program.** It requires the kernel module
   at phase 0, as any program that transforms code would.

### 1.2 Components

| Component | What it is | Where |
|---|---|---|
| host | Loads wasm modules, links them by name, and provides the `host` imports, among them the instantiate hook and file I/O (section 4). It owns no memory. | `host/subhost.c` (C, over wasmtime), `host/subhost.mjs` (JavaScript, over Node's V8), and, experimental, `host/web/` (a browser) |
| compiler | Reader, expander, kernel compiler and wasm encoder. | `compiler/*.sub`, written in the C-like Lisp |
| kernel module | The data of every language built on the kernel, syntax objects among them, in linear memory, and the functions of section 2. | `compiler/kernel.sub`, written in the C-like Lisp |
| run-time modules | What every program, the compiler included, rests on: the program's one memory, printing from it, and the C-like Lisp's allocator. | `compiler/memory.sub`, `compiler/print.sub`, `compiler/base/runtime.sub` |
| languages | Libraries that make a language: the C-like Lisp, which the compiler is written in; Substrate; and Bend. | `compiler/base/`, `lib/substrate/` and `lib/bend/`, the last two written in the C-like Lisp |

`lib/web/` (experimental) holds libraries for programs that run in a
browser.

### 1.3 What runs where

| | While compiling | While a program runs |
|---|---|---|
| the kernel module | the running compiler's own instance; all compile-time code links to it | instantiated only if the program's linklets import it |
| GC | none: syntax and other compile-time data are the kernel module's, in memory | only if the program's code uses GC types |
| memory and table | a linklet's own if it declares them; otherwise compile-time code takes the kernel module's (3.3) | a module's own, or taken from a module it requires (3.3) |
| the host | no memory of its own; it reads and writes the caller's | the same |

A **store** is one wasm store with one linker. The compiler runs in one
store, and gives each module's compilation a namespace in it (3.2). The
namespace holds the linklets the module's compile-time code runs in, and
the linklets of the modules it requires. A **run-time store** holds the
linklets a program loads.

The compile-time environment is not garbage collected. Syntax objects are
the kernel module's data, in memory, made in arenas that are freed all at
once: a module's arena when its compilation ends.

Compile-time code shares the compiler's memory, allocator and stack, so it
can corrupt the compiler's state. The compiler is therefore safe only for
trusted compile-time code. A program that compiles code it does not trust
should run the compiler in a separate sandbox, as the REPL page does
(README, "Guests").

### 1.4 Bootstrap

The compiler is written in the C-like Lisp (`compiler/*.sub` and
`compiler/base/`) and requires the kernel module (`compiler/kernel.sub`).
It is built by an earlier build of itself, the **seed**, which is checked
in (`seed/`). `bin/sub` runs the compiler in `build/sub`, and rebuilds it
when the compiler's sources or the seed are newer: the seed builds the
sources into `build/sub-1`, and that build builds them again into
`build/sub`. So `build/sub` is always the source compiled by itself, even
when the seed is older than the source.

The bootstrap reaches its **fixpoint** when `build/sub` builds itself into
the same bytes, every linklet included (`make bootstrap`, which runs
`bin/bootstrap`). That needs compilation to be deterministic, which is why
the host gives programs no clocks or randomness (section 4). A build also
does not depend on where the repository is or where it is run from, since
files are named relative to the package root (3.6).

For the compiler's source to use something the seed does not know, the
feature is added first, and then the seed is replaced by the new build
(`make seed`, which checks the fixpoint first). Earlier seeds stay in the
repository's history.

**The running kernel.** Compile-time code links to the kernel module of the
build that runs the compiler, the **running build**. The compiler is given
that build's directory (`-r DIR`, which `bin/sub` passes) and reads the
kernel module's functions and tags from its linklets. A program that uses
the kernel module carries those linklets too, except where the compiler
compiled a linklet of the same name in the same run, which then takes its
place. So when the compiler builds itself, the new build holds the kernel
module compiled from the current source, while the compile-time code of
that build still runs against the running build's kernel module. A change
to `kernel.sub` therefore reaches compile-time code one build later, which
is one reason `bin/sub` builds the compiler twice.

The cache and compiled files (3.7) are keyed to the running compiler, by a
hash of its build's linklet names. A change to how the compiler compiles
is therefore never hidden by modules that an earlier build compiled.

**History.** The first compiler was written in Substrate, over a kernel
module whose data were wasm GC objects, and was built by **stage0**, a
compiler for the same language written separately in Chez Scheme. Stage0's
build of the compiler built itself, that build built itself again, and all
three were the same bytes: two compilers written separately, in different
languages, produced the same compiler. Stage0 was retired after commit
3e74bce, where this still held. The compiler in the C-like Lisp was built
first by the Substrate compiler and then by itself. Both earlier compilers
remain in the history.

## 2. The macro contract

Macros read and build syntax with the kernel module, `compiler/kernel.sub`.
`(require name kernel)` binds its definitions (2.3).

### 2.1 Transformers

A **transformer** is a datum (2.2) that the expander calls with the syntax
object of a macro use: the whole form, or the identifier alone. The
expander then expands the syntax object that the call returns.

- `(make-transformer code env)` makes a transformer whose code is called
  with `env` and the syntax. `code` is the table index (`func-index`, 5.3)
  of a function of type `(i32 i32) -> i32`.
- `(make-function-transformer code)` makes a transformer whose code, of
  type `(i32) -> i32`, is called with the syntax alone.

The index is into the table that compile-time code shares with the
compiler (3.3), so the expander calls the code directly. A name that
`define-syntax` binds to a transformer is a **macro** (6.3).
`(define-syntax m f)`, where `f` names a phase-1 function of type
`(i32) -> i32`, binds `m` to a transformer that calls `f`.

### 2.2 Data

The kernel module's data are **datums**, each an `i32`:

- `0` is `#f`.
- An odd number is a **fixnum**: an integer from -2^30 to 2^30 - 1, held
  in the datum's upper 31 bits.
- Anything else is the address of a **cell** in the kernel module's
  memory: a pair, the empty list, `#t`, a symbol, a keyword, a string, an
  integer outside the fixnum range, a flonum, a character, a syntax
  object, a record or a transformer.

The contract promises this about them:

- `i32.eq` (`==` in the C-like Lisp) is identity. The empty list and `#t`
  are single cells. Symbols and keywords are interned, so two with the
  same name are the same datum, and equal fixnums are the same datum.
  Equal characters, strings, larger integers and flonums are not
  guaranteed to be the same datum: compare characters with
  `char->integer`, strings with `string=?`, numbers by their values, and
  anything with `equal?`.
- Counts, indexes, bytes and predicate results are `i32` numbers, not
  data: `(length l)` is a count, and `(pair? v)` is 1 or 0. Since data are
  `i32`s too, wasm's type checking does not keep the two apart. The C-like
  Lisp does, with the type `datum` that the kernel module provides.
- Everything else about the representation is private (appendix A).

### 2.3 Functions

`(require name kernel)` binds, as `name:thing` and at the phase where it
appears, the kernel module's functions, its types `datum`, `srcloc` and
`scope-set`, its exception tag `compile-error`, and its macros; plus
whatever the require lists to bind unqualified (3.1). In kernel code a
`datum` is an `i32`. In the table, a parameter is a datum unless it is
marked with another type, and a predicate returns `i32` 1 or 0.

| Group | Functions |
|---|---|
| atoms | `(boolean b:i32)`, `(boolean? v)`, `(fixnum n:i32)`, `(fixnum? v)`, `(fixnum-value v) -> i32`, `(make-integer n:i64)`, `(make-unsigned-integer n:i64)`, `(integer? v)`, `(integer-value v) -> i64`, `(integer-negative? v)`, `(make-flonum x:f64)`, `(flonum? v)`, `(flonum-value v) -> f64`, `(char? v)`, `(char->integer c) -> i32`, `(integer->char n:i32)` |
| lists | `nil`, `(null? v)`, `(cons a d)`, `(car p)`, `(cdr p)`, `cadr`, `cddr`, `caddr`, `cdddr`, `cadddr`, `(unsafe-car p)`, `(unsafe-cdr p)`, `(set-cdr! p d)`, `(pair? v)`, `(list? v)`, `(length l) -> i32`, `(reverse l)`, `(append a b)`, `(list-ref l n:i32)`, `(list-tail l n:i32)`, `(last l)`, `(take l n:i32)`, `(memq x l)`, `(member x l)`, `(assq x l)`, `(assoc x l)`, `(equal? a b)`, `(datum-hash d) -> i64` |
| strings and symbols | `(string? v)`, `(string-length s) -> i32`, `(string-byte s i:i32) -> i32`, `(string=? a b)`, `(string-append a b)`, `(symbol? v)`, `(symbol->string s)`, `(string->symbol s)`, `(symbol-append a b)`, `(symbol-hash s) -> i32`, `(keyword? v)`, `(string->keyword s)`, `(keyword->string k)` |
| syntax | `(syntax? v)`, `(identifier? v)`, `(syntax-e s)`, `(syntax->list v)` (a list, or `#f`), `(syntax->datum v)`, `(datum->syntax ctx d loc)`, `(syntax-rewrap s e)`, `(splice-list v)`, `(syntax-property s key)` (the value, or `#f`), `(syntax-property-set s key value)`, `(local-binding id)` (a datum, or `#f`), `(syntax-source s)`, `(syntax-line s)`, `(syntax-column s)` (where `s` is: its file as errors name it, its line from 1 and its column from 0, each `#f` if it has no location) |
| transformers | `(make-transformer code:i32 env)`, `(make-function-transformer code:i32)`, `(transformer? v)`, `(transformer-env t)`, `(call-transformer t s)` |
| errors | the tag `compile-error`, whose exceptions carry a message, the syntax blamed (or `#f`) and a source location (a `srcloc` pointer, or 0); `(raise-syntax-error name message stx)`, `(raise-compile-error loc message)` |
| queries | `(syntax-local-value id)` (the compile-time value `id` is bound to, a macro's transformer included, or `#f`), `(free-identifier=? a b)`, `(identifier-binding-kind id)`, `(identifier-function-signature id)`, `(local-expand stx)`, `(syntax-local-lift-definition form)`, `(syntax-local-introduce stx)`, `(syntax-local-facts id)` (6.5), `(identifier-name id)` (a symbol, or `#f`) and `(name-identifier name)` (6.6) |
| text | `(format template args)`, a string made from a template and a list of data; `(write-datum d)`, which prints a datum |

Code written in the C-like Lisp at compile time, such as Bend's checker
(`lib/bend/`), also uses the kernel module's lower-level functions:

- the bytes of strings and symbols in memory: `string-bytes`,
  `bytes->string`, `symbol-bytes`, `symbol-length`, `bytes->symbol`,
  `symbol-named` and `bytes->keyword`;
- arenas (appendix A): `run-arena`, `current-arena`, `use-arena`,
  `alloc-in` and `keep`, which copies a datum into the run's arena;
- tables keyed by data or integers: `make-table`, `table-ref`,
  `table-set!`, `table-count`, `datum-get` and `datum-put!`;
- records, a datum that stands for a struct of the caller's:
  `make-record`, `make-record-in`, `record?`, `record-kind` and
  `record-pointer`;
- list functions that take the C-like Lisp's closures: `map`, `for-each`,
  `filter`, `andmap`, `ormap` and `sort`;
- `format-message`, `write-to` and `buffer-add-utf-8!`, which work with
  the C-like Lisp's strings and buffers;
- the macros `sym`, `quoted`, `quasiquote` and `quasisyntax`, which quote
  data and build templates in C code.

The rest of what the module provides serves the compiler: scope sets
(`no-scopes`, `add-scope`, `flip-scope` and others), module arenas, and
the hooks the compiler fills (`set-queries!`, `set-scope-map!`,
`literal-buffer`, `deserialize`). Macros should not use them.

The functions behave as follows.

- **Numbers.** An integer literal is a fixnum if it fits in 31 bits, and
  an integer cell otherwise. Integers run from -2^63 to 2^64 - 1, as
  wasm's constants do, and are kept exactly. `integer?` holds for both
  kinds. `integer-value` gives the value's 64-bit two's complement, which
  is what arithmetic wants; with `integer-negative?` it gives the exact
  value, since a non-negative one is `integer-value` read as unsigned.
  `make-integer` makes the fixnum or integer for a signed `i64`, and
  `make-unsigned-integer` for an unsigned one. A decimal literal is a
  flonum, an `f64`.
- **Strings** are immutable bytes, and their lengths and indexes count
  bytes. The reader makes only UTF-8 strings; `bytes->string` does not
  check its bytes.
- `syntax-e` of an identifier is a symbol, and of a literal it is the
  literal's value. Of a list it is a list whose elements are syntax.
- `datum->syntax` wraps a datum, giving every new syntax object the scopes
  of `ctx` and the source location of `loc`, each a syntax object or `#f`
  for none. As in Racket, the two are separate: a macro usually takes
  scopes from its own templates or from the use, and the location from
  the part of the input the new syntax stands for, so that errors in the
  code it builds point at code the user wrote.
- `syntax-rewrap` copies syntax object `s` around a new datum `e`, keeping
  its scopes, source location and properties. `quasisyntax` is built on
  it.
- **Properties** attach data to a syntax object, for example a type that a
  macro computed for it. `syntax-property-set` returns a copy of `s` with
  `key` set. Keys are compared by identity, so symbols make good keys.
  Scope operations (6.1) do not reach into property values. The expander
  keeps a syntax object's properties when it adds or removes scopes, but
  does not copy the properties of a macro use onto the macro's result.
- `local-binding` identifies the local variable that identifier `id` binds
  or refers to in fully expanded code (6.4). It is an integer datum that
  is the same at the variable's binder and at each use, and different for
  every local variable in the compilation. It is `#f` for anything else,
  such as a global or an identifier that is not in fully expanded code. A
  pass uses it to tell which binder a variable refers to, as
  `free-identifier=?` would, but without asking the expander.
- `transformer-env` gives the `env` a transformer was made with. That is
  where a language keeps what goes with a binding, such as a struct's
  fields for its `match`, and it reads them back with
  `syntax-local-value`. `call-transformer` calls a transformer.
- Accessors trap with a message ("expected a pair") when they are given
  the wrong kind of datum.
- `unsafe-car` and `unsafe-cdr` are for code that has tested `pair?`
  itself. Given anything else, they return `#f`.
- `free-identifier=?` is 1 when `a` and `b` refer to the same bindings at
  the running macro's phase, as a value and as a type (6.1). An imported
  name and the definition it imports are the same binding. Two
  identifiers bound in neither namespace are equal when their names are.
- **Compile errors.** `compile-error` is the tag that syntax errors are
  thrown with. The compiler and all compile-time code share one instance
  of the kernel module (1.4), and tags are identified by instance (5.2),
  so this one tag lets them catch one another's errors. The expander
  throws one for each error in the code it expands. `raise-syntax-error`,
  as in Racket, throws one with `message`, a string, blamed on `stx`. The
  message is prefixed with `name: `, or, if `name` is `#f`, with the name
  `stx` gives: an identifier's own, or that of the identifier at the head
  of a list. A macro that blames part of its input passes its own name.
  `raise-compile-error` throws an error at a source location, blaming no
  syntax. A macro may catch the errors from the code it expands with
  `local-expand`, and the expander then goes on as if that expansion had
  not started. The compiler reports the others where the syntax they
  blame is, or, if it has no location, where the macro that raised them
  was used.
- `identifier-binding-kind` says what identifier `id` is bound to as a
  value at the running macro's phase: the symbol `function`, `variable` (a
  local or global), `macro` (a compile-time value that is a transformer),
  `compile-time-value` (any other), `data`, `tag`, `label` or `core` (a
  core form or wasm operator); `type` if it is bound only as a type; or
  `#f` if it is unbound. An implicit `#%app` (5.3) uses it to tell a call
  of a function from a call through a variable.
- `identifier-function-signature` gives the signature of the function `id`
  is bound to at the running macro's phase, as the datum `(t ... -> r
  ...)`, each type written as in the kernel: a numeric type's name, or
  `(ref T)` or `(ref null T)` with `T` a heap type's name. It is `#f` if
  `id` is not bound to a function. An implicit `#%app` uses it to tell
  whether a call gives a function the arguments it takes.
- `local-expand` expands expression `stx` at the running macro's phase and
  returns it as fully expanded code (6.4). A macro can then look at what
  its input becomes, and put the result in its output. As in Racket, the
  macro's introduction scope is flipped around the expansion, so code
  from the macro's input expands as it would at the use site.
- `syntax-local-lift-definition` adds a module-level form to the module
  body being expanded, at the running macro's phase (6.4): a `func`,
  `global`, `import`, `type`, `rec`, `data`, `tag` or `#%fact` form, an
  expression, or a `begin` of these, which are declared together. The
  form is declared as the macro's output is, with the use's introduction
  scope, so each use gets fresh names. It returns the form as given, so
  the macro can put its names in its output.
- `syntax-local-introduce` flips the running macro's introduction scope on
  `stx`: it turns syntax as the macro sees it into syntax as the module
  sees it, and back. A macro that keeps syntax from one use for another,
  such as the names of a definition it lifted, keeps it as the module sees
  it, and flips it again to put it in a later use's output.

The queries work only while an expander is running. Elsewhere, as in a
program, they trap.

## 3. Modules, linklets and linking

### 3.1 Modules and linklets

- One source file is one module (3.2). A module's code at one phase
  compiles to one wasm module, called a **linklet**, as in Racket. Phase 0
  is the program. Phase *n*+1 code runs while phase *n* is expanded, so a
  module's phase-1 linklet holds its transformers, its compile-time values
  and its `begin-for-syntax` code.
- `(provide item ...)` names the phase-0 bindings other modules get:
  functions, globals, macros, compile-time values, types, tags and data,
  whether the module defines them or imported them. An item `x` provides
  `x`, and `[new old]` provides `old` under the name `new`.
  `(all-from-out name)` provides everything that the module required as
  `name` at phase 0 provides, and `(except-out (all-from-out name) x ...)`
  provides all that except `x ...`; this is how a language built on
  another provides it with its own additions. A name bound both as a type
  and as a value provides both. One name cannot be provided for two
  different bindings.
- `(require name source item ...)` imports what another module provides.
  `source` is one of:
  - `"path"`, a file. A relative path is relative to the file the path
    string is written in, or, if the string has no location, to the file
    of the `require` form. So a require that a macro writes names a file
    relative to the macro's own file, not to the module being expanded.
  - `kernel`, the kernel module (section 2).
  - `(compiled "file")`, a compiled file (3.7), whose entry module it
    requires.

  How the names are bound:
  - Everything the source provides is bound **qualified**, as
    `name:thing`. Nothing is imported unqualified by default.
  - Each item also binds one thing unqualified: `x` binds `x`, and
    `[new old]` binds `new` to the source's `old`, in `let` order.
  - `(require-unqualified name source)` is `require` with every name the
    source provides also bound unqualified, with the scopes of `name`. It
    is meant for a language: the forms and functions its code is written
    in, such as its `define` and `#%app`, and little else, since
    unqualified names hide where a binding comes from. As in Racket, where
    a module's definitions shadow its language's bindings, a module-level
    definition of one of these names shadows the import throughout the
    module. It is an error if a macro use in the module relied on the
    import before the definition, since that expansion cannot be undone.
  - A require at phase *p* imports at phase *p*. To import for
    compile-time code, put the require inside `begin-for-syntax`. The
    required module's phase *q* is then phase *p* + *q* in the requiring
    module.
  - Requiring the same module again is harmless. A name that already names
    another module at that phase is an error, and so are cycles.
  - Qualified names are ordinary identifiers: `print:write-int` is one
    symbol. An import binds the name in each namespace the source provides
    it in (6.1). Binding a name twice in one namespace at the same phase,
    by definition or import, is an error.
- Expansion must run phase-1 code before the module is finished, since a
  macro works on the line after its definition. So while a module is
  expanded, each `begin-for-syntax` and each `define-syntax` runs at once,
  in source order, as Racket evaluates them. When the module is done, each
  phase's code is compiled again as a whole, into the module's linklet for
  that phase. Other modules only ever use those linklets.
- To keep running code at once cheap, the expander compiles only new
  code. It makes some values itself, with no new code: quoted data, a
  transformer that calls a function `define-syntax` names (6.3), and a
  call, on such values, of an already instantiated function from data to
  a datum. Other code is compiled into a linklet of its own and
  instantiated.

### 3.2 Stores and instance names

- Each module's compilation has compile-time instances of its own. The
  linklets of the module's compile-time code, and those of the modules it
  requires, are instantiated for it on demand. So no compile-time state is
  shared between the compilations of two modules, as in Racket. Compiled
  wasm code is not state: the host compiles a linklet's bytes once and
  instantiates the result wherever it is needed. The compiler runs in a
  store of its own and gives each compilation a namespace in it (below),
  since macros share syntax objects with the compiler by address.
  The kernel module's instances are the exception: they are the running
  compiler's, shared by every compilation (1.4).
- A module's identity is a hash of its path (3.6), its source, and the
  hashes of the modules it requires, at the phase shifts it requires them
  at (64-bit FNV-1a over those strings, each followed by a zero byte, and
  its top 48 bits in hexadecimal). `<module>` is its file's stem and that
  hash, such as `print.9f1cfd92b643`. The hash covers what the module's
  bytes depend on, since its source locations name its path: two modules
  with one hash are the same bytes. So the hash does not depend on the
  order modules are compiled in, or on where the package is, and a file
  copied to another path is another module. While a module is expanded,
  its compile-time linklets are named after its stem, since its requires
  are not known yet.
- A module's linklet instantiated at phase shift *t* is registered as
  `<module>@<phase>+<t>`. A compiled linklet imports from other linklets
  by names relative to its own module at phase shift 0, so one compiled
  linklet serves at any phase: when the compiler instantiates the linklet
  at phase shift *t*, it maps each such import to the linklet at shift *t*
  higher, with `instantiate`'s import map (section 4).
- A program runs in a fresh run-time store holding exactly the linklets
  reached from its phase-0 linklet at phase shift 0. A module required
  only inside `begin-for-syntax` is never loaded at run time.
- The other instance names are `host`, the linklets of compile-time code
  (`<module>@<phase>#<n>`), and any extra modules a host provides
  (section 4). The kernel module's linklets are the running build's, under
  their module names.
- **Namespaces**: the compiler registers a compilation's instances as
  `<ns>/<name>`, and maps the imports of each from linklets to
  `<ns>/<linklet>`, after the phase shift. Its other imports, such as the
  kernel module's and `host`, are the store's. These names mean something
  only to the compiler: the host links each import to the instance the map
  names, or to the instance its module name names.

### 3.3 Linking

- **A module imports only what its code uses.** Nothing is bound or
  imported by default. Code that calls a required module's functions
  imports from that module's linklet. Code that calls the kernel module,
  or uses `quote`, `quasiquote`, `quote-syntax` or `quasisyntax`, imports
  from the kernel module's linklet.
- **A module owns its memory and table, or takes them from a module it
  requires.** `(memory pages)` defines memory 0. `(memory from name)`
  imports the memory of the module required as `name` at the same phase,
  so a program's modules can share one memory. Tables work the same way.
  Code that uses memory instructions or data segments needs a memory, and
  code that uses `func-index` or `call-indirect` needs a table. A program
  written in the C-like Lisp has one memory, `compiler/memory.sub`'s,
  which every module takes, the kernel module included.
- **Quoted data is in the kernel module's memory** (3.5). A module that
  quotes data and declares no memory takes the kernel module's. A module
  that defines a memory of its own cannot quote data.
- **At phase 1 and above**, a compile-time linklet that declares no memory
  or table takes the kernel module's, which it shares with the compiler.
  `(memory from name)` and `(table from name)` work as at phase 0, with
  `name` the kernel module, a module required at that phase, or a module
  that takes the kernel module's memory. A phase's compile-time linklets
  that declare `(memory pages)` share one memory: the first linklet after
  the declaration defines it and later ones import it, so, as with
  macros, code can use it only after the declaration. Tables work the same
  way. Data segments at phase 1 and above need a memory of their own.
- A linklet exports its memory as `"memory"` and its table as `"table"`
  (the host relies on this, section 4), and every module-level function,
  global and tag under its name. If two bindings share a name, the
  compiler appends `.<n>` to later ones.

### 3.4 Freestanding modules

`(freestanding)` declares that the program needs nothing beyond the host
at run time, in the sense C, Zig and Rust give the word: no run-time
library. After expansion, the compiler checks every linklet the program
would load: each may import only from the host and from the program's
other linklets, not from the kernel module, and none may use GC types.
The check runs after expansion because macros can add dependencies the
program never wrote.

### 3.5 Initialization

A global whose initializer is a constant expression (5.2) gets it as its
wasm initializer. The others start at their type's default, zero or null.
Then the linklet's start function runs:

1. For each function whose table index the linklet takes (`func-index`),
   the function is appended to the table and its index kept in a global,
   in the order the compiler meets them.
2. The linklet's quoted data is built.
3. The other global initializers and module-level expressions run, in
   source order.

**Quoted data.** The compiler serializes a linklet's quoted data, other
than `#f`, into one passive data segment, in the format of
`compiler/serialize.sub`. When the linklet starts, the kernel module's
`deserialize` turns the segment into a table of data in the kernel
module's memory, in the current arena, and code reads a quoted datum from
that table. `#f` is `(i32.const 0)`. So compiled code does not grow with
its literals, and each is built once per instance. As in Scheme, equal
quoted data may share structure: whether two quoted data, or parts of
them, are the same datum is unspecified.

A syntax object in the quoted data names its scopes by index into the
linklet's **scope table**: the scopes of its literals, in the order the
compiler met them, which the compiler keeps with the linklet. A scope is a
number belonging to the run that made it, and this way the bytes do not
depend on that run. Before the compiler instantiates a linklet at compile
time, it gives the kernel module the run's scope for each index
(`set-scope-map!`, appendix A). A linklet that a program runs gets no map,
and its literals keep the indexes, which nothing reads at run time.

A phase-1 linklet's module-level expressions run each time the linklet is
instantiated, which is once per compilation that needs it.

### 3.6 Source locations

A linklet says where its code comes from in a custom section,
`source-locations`, so that a host can put a source location on each
frame of a backtrace:

```
vec(name)                      the files, as the locations name them
vec(entry)                     by offset; entry: offset file line col
```

Each field is an unsigned LEB128. `offset` is the entry's offset in the
module, less the previous entry's (the first's, less 0); `file` is an
index into the files; `line` counts from 1 and `col` from 0; and a `line`
of 0 means no location. An instruction's location is that of the last
entry at or before its offset. Entries are made only where an instruction
that can call or trap starts at a new location, and at the start of each
function's body, with the function's own location, since those are where
a backtrace's frames are: an engine reports a frame that overflowed the
stack as it entered the function, at the body's start. A function that
made a tail call has no frame left to show.

The location of code is that of the syntax it was compiled from, with two
exceptions for code that a macro from another file introduced, whose own
location is in that macro's file. Such code takes the location of the
nearest enclosing code of the linklet's own file, if there is one; and a
macro's output whose outermost syntax object comes from another file than
the use takes the use's location, as does each form of a module-level
`begin` that is such output (6.2). So what a library's macro expands to is
located where the macro was used. The code of an inline function (5.2)
takes the location of the call it is inlined at.

A file is named canonically, as Racket names a module, and its name names
the module in it (3.2). The compiler runs from the **package root**, which
is the repository unless `-p DIR` names another, and whose absolute path
`bin/sub` gives it; `bin/sub` also gives the directory it was run from
(`-d DIR`), from which the command's file arguments are read. A path is
completed from that root and its `.` and
`..` segments resolved, then named relative to the root if the file is in
the package, and by its absolute path if not. So a file has one name
however a `require` spells it, relative or absolute, and a module's bytes
are the same wherever the package is. Symbolic links are not resolved: a
file reached through one has another name.

### 3.7 The cache

With a cache directory (`sub build -c DIR`; `bin/sub` gives `build/cache`
unless told another), a module compiled once is loaded from the cache
while its source and its requires are as they were. What the cache keeps
is the module's **interface**: what the expander keeps of a module it
compiled, with its linklets inside, one per phase, as quoted data in the
kernel module's format (3.5).

- An interface begins with what it is of: the interface format's version,
  the compiler by hash (1.4), the module's hash (3.2), and its requires by
  path, hash and phase shift, a macro-introduced `require` among them. The
  cache holds one file per source path, named by a hash of the path, with
  the interface of the module last compiled from that path; compiling the
  path again replaces it, so the cache does not grow as sources change.
  To look a module up, the compiler reads that file. It takes the
  interface if it is of this format and compiler, if the module's hash,
  computed from its source and the recorded requires' hashes, comes out
  as recorded, and if the recorded requires, compiled or loaded in order
  as they would be to compile the module, each have the recorded hash. So
  a require that the source no longer has is not looked at, and neither
  is any after the first that changed.
- The cache knows what a module's expansion read only by its source and
  its requires. Compile-time code can also read other files and the
  command line through the host (section 4). A module whose expansion
  depends on them is loaded as it was first compiled until its source or
  a require changes, and `rm -rf build/cache` starts over. A module loaded
  from the cache runs none of its compile-time code, so what that code
  printed is not printed again.
- An interface holds what compiled code refers to in the module and what
  other modules' expansions need: its provides, its module-level bindings
  with their scope sets and phases, its functions with their signatures,
  declared types and values, its globals, tags and data, its types as
  structural forms, the getters of its compile-time values, its facts
  (6.5), the lowered bodies of its inline functions, and its linklets,
  with their imports and scope tables. Scopes and definitions belong to a
  run, so the interface names them relative to modules: a scope is the
  core scope, a module scope's copy for a phase shift, or the *n*-th scope
  a module's expansion made; a definition is the module's own, or another
  module's by instance and export name, the kernel module's among them.
  Once loaded, a module binds its entries under scopes made for it,
  installs its requires at their shifts, and registers its linklets, types
  and definitions as a compiled one would. Its compile-time values are
  computed per compilation as before (6.3).
- A **compiled file**, `.subc`, holds modules, each its interface with its
  linklets inside: those a module requires come before it, and the entry
  comes last. `sub build FILE -o DIR -m OUT` writes the compiled file of
  `FILE` and every module it requires at any phase to `OUT`; the cache's
  files hold one module each.
  `(require name (compiled "file"))` loads the file's modules in order,
  except those the run has made already, and requires its entry. A module
  of another interface format, or compiled by another compiler, is an
  error.
- A linklet's bytes do not depend on the run that compiled it (3.5) or on
  where it was built from (3.6), so a program built from cached modules is
  byte for byte the program a cold build writes. `make check` removes the
  cache, builds every test, then builds each again from the cache and
  compares. A module that a compiled file brought and a file the run
  compiles can be one module, of one hash (3.2): the run keeps the first it
  has, and expands the second for what its expansion does. A compiled
  module has the compiler's decisions in it, so a new compiler does not
  use the interfaces an older one wrote. `sub expand` expands from source,
  since it prints the expansion, and does not compile the module it
  prints.

### 3.8 Sessions

A **session** compiles and runs code one piece at a time, as a REPL does.
`sub eval FILE` runs each top-level form of `FILE` as one input of a
session; the REPL page (`lib/web/repl/`) runs a session in a sandbox.

- Each input is expanded as a module body of its own and compiled into a
  linklet, which is instantiated at once in the compiler's store, as
  compile-time code is (3.2). So the session's code, run-time code
  included, runs inside the compiler, and is trusted as compile-time code
  is (1.3).
- A session has no fixed language. As in a file, the language is whatever
  the inputs `require`. A session that requires nothing is in kernel code.
- A definition made by one input is visible to every later input. A later
  input may define a name again: later inputs then see the new
  definition, while code compiled earlier keeps the old one, since a
  compiled call refers to a function, not to a name.
- An input that contains an expression `e` is rewritten to
  `(#%top-interaction e)` if the session's language binds
  `#%top-interaction` to a macro, as an application is rewritten to
  `#%app` (5.3). The language's macro decides what to do with the value,
  usually print it. Without such a macro the expression is run and its
  value dropped.
- An input that fails, by a compile error, an exception that escapes its
  code, or a trap, leaves the session as it was, apart from what its code
  had already done: its definitions are removed. A trap inside a macro
  unwinds the compiler's own stack, so the program running the session
  must recover it from its `on-trap` (section 4).

## 4. Host interface

The host provides imports from the instance `"host"`. Every parameter and
result is an `i32`, and every pointer is an offset into the **caller's
own memory**, the one the calling instance exports as `"memory"`. The
host provides no clocks, randomness or other nondeterminism, so
compile-time execution is reproducible, which the bootstrap fixpoint (1.4)
depends on. The files a program reads and its arguments are its input,
like the source a compiler reads.

| Import | Type | Meaning |
|---|---|---|
| `write` | `(fd ptr len) -> i32` | write bytes to standard output (fd 1) or standard error (fd 2); returns `len` |
| `trap` | `(ptr len) -> ()` | abort with the UTF-8 message at `ptr` |
| `instantiate` | `(name name-len bytes bytes-len map map-len) -> i32` | compile and instantiate the wasm module in `bytes`, and register it as `name`. The map is pairs of names, a module's then an instance's, each followed by a zero byte: an import from a module the map names links to that instance, and any other import to the instance its module name names (3.2). Returns 0 on success, or 1 with the error set. An exception that escapes the module's start function goes on to the caller, as from a call. |
| `export_index` | `(inst inst-len field field-len) -> i32` | append the function `inst.field` to the caller's table (exported as `"table"`) and return its index, or -1 |
| `error_message` | `(buf cap) -> i32` | copy the last error of `instantiate`, `read_file` or `write_file` into `buf`; returns its full length |
| `arg_count` | `() -> i32` | the number of the program's command-line arguments |
| `arg` | `(i buf cap) -> i32` | copy at most `cap` bytes of argument `i` into `buf`; returns its full length, or -1 if there is no argument `i` |
| `read_file` | `(path path-len buf cap) -> i32` | copy at most `cap` bytes of the file named by the UTF-8 path into `buf`; returns the file's size, or -1 with the error set |
| `write_file` | `(path path-len buf len) -> i32` | write the `len` bytes at `buf` to the file named by the path, creating or replacing it; returns 0, or -1 with the error set |
| `exit` | `(code) -> ()` | end the process with status `code` |

`instantiate` is **the hook**: wasm cannot make new code executable by
itself, and this is how it does. The compiler runs compile-time code with
it. An instantiated module can reach exactly what its imports name.
`tests/hook.sub` tests the hook from kernel code. A path is relative to the
process's working directory, which is the package root when `bin/sub`
runs the compiler (3.6).

**Running a program.** `sub build FILE -o DIR` writes the program that
`FILE` is the entry of: each linklet it instantiates at run time, as
`DIR/<instance name>.wasm`, and `DIR/program`, their instance names one per
line, each after the linklets it imports from, the entry's own last.
`build/subhost DIR arg ...` runs it. In one store, it instantiates each
linklet under its name, gives the program the arguments, and calls the
entry's `main`, if it exports one. Its exit status is:

- 0 when `main` returns, or when there is no `main`;
- 1 when a file of the program cannot be read;
- 2 when a linklet cannot be instantiated, when `main` traps, or when an
  exception escapes `main` or a start function (reported as `uncaught
  exception`: a host cannot read what an exception carries, which is the
  language's);
- the status the program passes to `exit`.

Wasm code cannot catch a trap, but the store stays usable after one. If
the entry exports a function `on-trap`, the host calls it after a trap in
`main`, with the trap's message as its last error message
(`error_message`), and it reports the trap instead of the host. The
compiler's `on-trap` reports the message where the macro or other
compile-time function that trapped was used. A trap's message is its
cause and then its backtrace, one frame per line, each with its source
location when the frame's linklet has one (3.6). Wasm is the program's
form on disk; the engine compiles it to machine code each time it is
loaded. The compiler is such a program, and runs on a 4 MiB wasm stack.

**The other hosts.** `host/subhost.mjs DIR arg ...` is the same host over
Node's V8. `bin/sub` runs the compiler on `build/subhost` unless the
environment variable `HOST` names another host, such as
`host/subhost.mjs`. V8's JavaScript API does not tell a host import which
instance called it, so this host finds the caller's memory and table
through the caller's exports. For the same reason it runs a module's start
function just after instantiating it, rather than during instantiation,
when the exports do not exist yet. Wasm code can catch a JavaScript
exception, so this host makes its traps, such as `trap`'s, by calling a
wasm function that traps.

The browser host (`host/web/`, experimental) runs a program in a web page.
It keeps the program's instances after `main` returns, so the page can
call the program's exports when events happen, and it keeps the program's
files in memory. A JavaScript host may also give a program extra
**host modules**, each under its own instance name: the browser host
offers `dom`, `audio`, `gpu` and `guest`. A program can import only from
the modules its host gives it, so they also work as permissions. The
compiler is run with none, so compile-time code cannot use them, and
builds stay reproducible.

## 5. The kernel language

The kernel is WebAssembly written as S-expressions, plus bindings,
quotation and compile-time forms.

### 5.1 Types

- Numbers: `i32`, `i64`, `f32`, `f64`.
- References: `anyref`, `eqref`, `i31ref`, `structref`, `arrayref`,
  `funcref`, `externref`, `exnref`, and `(ref T)` or `(ref null T)` where
  `T` is one of `any eq i31 struct array func extern exn none nofunc
  noextern noexn`, a declared type, or `(closure (t ... -> r ...))`, the
  closure type of that signature (5.3). A declared function type is below
  `func` only: functions are not in the `any` hierarchy, and neither are
  exceptions (`exn`, 5.3).
- The words of type syntax (`ref null mut struct array field sub final
  func rec ->`) are compared by name, like wasm's keywords, not looked up
  as bindings. So they are reserved: a declared type may not be named by
  one, nor by a built-in type name (including `i8`, `i16` and the
  shorthands such as `eqref`).
- A function result is written `-> t` or `-> (t ...)`, or omitted when
  there is none. Function types in imports and `call-indirect` are written
  `(t ... -> t ...)`.
- Types are checked with wasm's subtyping: `(ref T)` fits where
  `(ref null T)` is expected, a declared struct type fits `structref` and
  its declared supertypes, every struct, array and `i31ref` fits `eqref`,
  and so on.
- **Declared types are identified as wasm identifies them**: a type is its
  recursion group's structure and its place in the group, that is, the
  members' kinds, finality, supertypes, and field and signature types, in
  order. Names, field names included, are not part of it. So two
  declarations of the same structure are one type wherever they are, in
  two modules or lifted by a macro, and the checker agrees with wasm's
  run-time tests, `ref.test` and `ref.cast`. A type standing alone is a
  group of one. Mutually recursive types are written in one `rec` group,
  whose member order matters, as in wasm, so code that generates recursive
  types, such as a type function, should declare each strongly connected
  set of them as one group, in a canonical order. Code that must tell
  values of the same structure apart stores the difference in the value.
- **Type functions.** In a type position, a form whose head is a macro is
  expanded until it is not, so a compile-time function can compute a
  type: `(ref (tuple i32 3))`, as in Zig. Such a macro usually declares
  the type with `syntax-local-lift-definition` and returns its name. Uses
  in any module get the same type, since the declarations have the same
  structure; the macro can remember the name, as the module sees it
  (`syntax-local-introduce`, 2.3), to declare the type once per module
  (`tests/fixtures/tuple.sub`). Type positions are the types of
  parameters, results, globals, `let` bindings, fields and signatures, and
  the type immediates of GC instructions.

### 5.2 Module-level forms

```
(func (name [param type] ...) [#:inline] [#:value g] [-> result] [(type T)] body ...)   ; T: a function type
(global name type init)             ; immutable; init is a constant expression
(global name (mut type) init)       ; mutable
(import name "module" "field" (type ... -> type ...))   ; or a function type name
(memory pages)  (memory from name)
(table size)  (table from name)
(data name offset "bytes" ...)      ; active segment at offset in memory
(type name (struct (field fname ftype) ...))   ; ftype: storage or (mut storage)
(type name (array ftype))                      ; storage: a type, i8 or i16
(type name (sub [final] [super] def))          ; def: (struct ...) or (array ...)
(type name (func (t ... -> t ...)))            ; a function type
(rec (type name def) ...)                      ; types that refer to each other
(tag name (type ...))               ; an exception tag, carrying values of the types
(require name source item ...)      ; source: "path", kernel or (compiled "file"); item: x or [new old]
(require-unqualified name source)   ; every provided name unqualified too (3.1)
(provide item ...)                  ; phase 0 only; item: x or [new old]
(freestanding)                      ; see 3.4
(define-syntax name expr)           ; name bound to expr's value at phase+1 (6.3)
(define-syntax name f)              ; f: a phase+1 function; a transformer (2.1)
(begin-for-syntax form ...)         ; forms at phase+1
(begin form ...)                    ; spliced
expr                                ; runs at instantiation
```

A module body is expanded in two passes, as in Racket. The first pass
expands macro uses at the head of each form, registers definitions, runs
`begin-for-syntax` and the right-hand sides of `define-syntax` at once,
processes `require`, and splices `begin`. The second pass expands function
bodies and expressions. So functions may be mutually recursive, and a
macro must be defined before it is used. A function named in
`(define-syntax name f)` must come from an earlier `begin-for-syntax`, or
from a module required inside one.

A macro used at module level runs in the first pass, so it sees only the
definitions before it; `identifier-binding-kind` reports a later one as
unbound. A macro that needs the whole module can expand into a core
expression form, such as `let`, whose contents wait for the second pass.
Module-level applications and literals are expressions: their implicit
`#%app` and `#%datum` (5.3, 5.4) are applied in the second pass, when every
definition is known. Racket applies `#%app` in the first pass, which is
harmless there because its `#%app` does not depend on what the function
is; here a language's `#%app` usually does (`identifier-binding-kind`). So
an application cannot expand into a definition; a language provides a
named form, such as `define`, for that.

Type declarations follow wasm. A type without `sub` is final and has no
supertype. `(sub super def)` declares a subtype of `super`, which must be
an earlier non-final type of the same kind; a struct starts with its
supertype's fields, and a field may narrow its type only if it is
immutable. `(sub final ...)` has no subtypes. A `type` form is a recursion
group of its own, so its type may refer to itself and to earlier types,
but not to later ones. `(rec (type name def) ...)` declares types that may
refer to each other, as one wasm recursion group; a supertype must still
be an earlier member or an earlier type. Wasm compares declared types
group by group, so a type in a group is the same wasm type only as the
same member of an identical group.

**Function types** are declared like the others:
`(type T (func (t ... -> r ...)))`, also with `sub` and in a `rec` group. A
function subtype takes parameters that its supertype's fit, and returns
results that fit its supertype's, as in wasm. A function is given a
declared type by a `(type T)` clause first in its body, as in wasm's
`(func $f (type $t) ...)`; its parameters and results must be `T`'s. That
type is part of the function's declaration, so other modules import the
function at `T`, and `(ref.func f)` is a `(ref T)`. A function without the
clause has only its signature, and `ref.func` does not accept it. An
`import` can name a function type in place of the signature.
`(call-ref T f arg ...)` calls `f`, a `(ref null T)`, and is emitted as
`return_call_ref` in tail position. A closure is the usual case: its
struct and its code's function type refer to each other, so they are one
`rec` group.

**Inline functions.** `#:inline` after a function's head makes it an
inline function: a direct call of it, in any module, is compiled as its
body, with the arguments bound to new locals in order and the result at
the function's declared result types; a `return` in the body leaves only
the body. A wasm engine cannot inline a call of another module's
function, because modules are compiled separately and linked when they
are instantiated, so this is how a library's small functions, such as the
kernel module's fixnum tests, are inlined into the code that uses them. A
call is compiled this way only if the function's body has been compiled
before it: a function's calls of itself, and calls before its definition
in its own module, stay calls. So that an inlined call does what the call
would, the body must not depend on which module it is compiled in:

- It may not use a table, `call-indirect`, `func-index`, or an
  instruction that names a data or element segment, since in another
  module they would be that module's. `data-address` and `data-size` are
  constants, so a body may pass them to its own module's functions.
- It may use memory, but then a call is inlined only where the code being
  compiled uses the same memory as the function's module: the memory of
  the same instance, taken through `memory from` (3.3). Elsewhere it stays
  a call.
- It may quote data. Quoted data is made by the module that the call is
  compiled in, which therefore needs the kernel module's memory (3.3).
- It may call its own module's functions, use its globals, take
  `ref.func` of its functions and throw its tags: every definition is
  exported (3.3), and a module that inlines the body imports what it uses.

A call in an inline function's body to an inline function compiled
before it is inlined there too.

**Function values.** `#:value g` after a function's head, where `g` is a
global, makes `g` the function's value: the function's name used as an
expression, in any module and at any phase, means `g`, while a call of it
stays a call. Without `#:value`, a function's name is not an expression
(use it with `func-index` or `ref.func`). A language with first-class
functions makes a function's value a closure once, in a global, and
records it with `#:value`, so that every use of the name is the same
value. Substrate's `define` does so, and its `#%app` calls the function
directly when it gets the arguments the function takes
(`identifier-function-signature`, 2.3).

Globals follow wasm too. A global is immutable unless its type is written
`(mut type)`, and `set!` of an immutable global is an error. An
initializer that is a **constant expression** is compiled into the global
itself, as wasm requires of an immutable global. The constant expressions
are literals, `'#f`, `ref.null`, `ref.i31`, `ref.func`, `struct.new`,
`array.new`, `array.new_default` and `array.new_fixed`, `add`, `sub` and
`mul` on `i32` and `i64`, reads of immutable globals that are imported or
defined earlier in the module, each with constant operands, and a
`lambda`, which captures nothing at module level (5.3). Any other
initializer runs when the module is instantiated, in source order with
the module's other expressions, so only a mutable global of a numeric or
nullable type may have one. Another module that imports a global imports
its mutability with it.

**Tags** follow wasm too. `(tag name (t ...))` declares a tag: an
exception thrown with it (5.3) carries values of the types `t ...`. Unlike
a type, a tag is identified by the instance that defines it, as in wasm:
two declarations of the same tag are two tags, and so are the tags of two
instances of one module, such as its linklets at two phase shifts. A
module that imports a tag gets that tag. So code that must catch the
exceptions of code in other instances shares a tag with it, as all
compile-time code does with the kernel module's `compile-error` (2.3).
Exceptions need no GC: a freestanding program (3.4) can throw and catch
them.

### 5.3 Expressions

```
literal                             ; see 5.4
id                                  ; local or global variable
(set! id expr)
(let (binding ...) body ...)        ; parallel scope
(let* (binding ...) body ...)       ; sequential scope
                                    ; binding: [id expr] [id type expr]
                                    ;   [(id ...) expr] [(id ...) (type ...) expr]
(values expr ...)                   ; several values
(lambda ([id type] ...) [-> r] body ...)           ; a function over the locals around it
(begin expr ...)
(if test then [else])
(block label body ...)              ; br to label exits the block
(loop label body ...)               ; br to label restarts the loop
(br label [expr])  (br-if label test)  (return [expr])
(br-table (label ...) default index)    ; br to the index-th label, or to default
(f arg ...)                         ; application: (#%app f arg ...)
(#%app f arg ...)                   ; core: a direct call of the function f
(#%app e arg ...)                   ; core: an application of the function value e
(op arg ... [offset])               ; a numeric or memory instruction, e.g. (i32.add a b)
(call-indirect (t ... -> t ...) index arg ...)
(ref.func f)                        ; (ref T), for f declared with (type T)
(call-ref T f arg ...)              ; call f, a (ref null T)
(func-index f)                      ; i32 index of f in the module's table
(data-address name)  (data-size name)
(i32.const n)  (i64.const n)  (f32.const x)  (f64.const x)   ; a constant of that type
(select a b test)  (drop expr)  (unreachable)  (nop)
(throw tag arg ...)  (throw-ref e)  ; throw an exception; throw e, an exnref, again
(try (clause ...) body ...)         ; clause: [catch tag (x ...) body ...]
                                    ;   [catch-ref tag (x ... e) body ...]
                                    ;   [catch-all body ...] [catch-all-ref (e) body ...]
(quote d)  (quasiquote d)           ; kernel data (2.2)
(quote-syntax d)  (quasisyntax d)   ; syntax objects
```

GC instructions take their type and field immediates by name:

```
(struct.new T arg ...)   (struct.get T field e)   (struct.get_s T field e)
(struct.get_u T field e) (struct.set T field e v)
(array.new T init len)   (array.new_default T len)   (array.new_fixed T arg ...)
(array.get T a i)  (array.get_s T a i)  (array.get_u T a i)  (array.set T a i v)
(array.len a)  (array.fill T a i v n)  (array.copy T1 T2 dst di src si n)
(ref.null heap)  (ref.is_null e)  (ref.eq a b)  (ref.as_non_null e)
(ref.test reftype e)  (ref.cast reftype e)  (ref.i31 e)  (i31.get_s e)  (i31.get_u e)
```

- Types are checked bidirectionally. An integer literal takes the type its
  context expects (`i32` if none), and a decimal literal is `f64` unless
  the context says `f32`. The constant forms, wasm's own, give a literal
  its type whatever `#%datum` means where they are written (5.4), so
  kernel code means the same in any module: in a module whose language
  makes literals data, `(i32.const 0)` is still an `i32`. Their literal is
  an integer, or for `f32.const` and `f64.const` a number. A mismatch is a
  compile error before any wasm is emitted.
- Non-final expressions in a body are dropped. An `if` without an else,
  and any expression whose value is unused, has no value. The branches of
  an `if` may differ when both are references: its type is the least type
  both fit, such as their common declared supertype, or `eqref`. Without
  an expected type, a branch that is a literal alone takes the numeric
  type of the others: `(if c 0 x)` is an `i64` if `x` is.
- **Several values.** `(values e ...)` gives the values of `e ...`, in
  order, where a function's body or a block gives several results. A
  `let` binding `[(x ...) init]` binds each `x` to one of the values that
  `init` gives, in order; with `(type ...)` the values must have those
  types. `init` is usually a call of a function of several results
  (`-> (t ...)`). The number of variables must match the number of values.
- **`br-table`** branches to the label that `index`, an `i32`, says,
  counting from 0, or to `default` if `index` is past the labels, as wasm's
  `br_table` does. Each label is a loop's, or a block's that produces
  nothing, as with `br-if`. A switch is its blocks, each case's code after
  its own block, so the dispatch is one jump.
- **`try`** runs its body. If an exception that one of its clauses catches
  escapes the body, the first such clause runs in place of the rest of the
  body: `catch` catches the exceptions of its tag and binds its variables
  to their values, `catch-all` catches any exception, and `catch-ref` and
  `catch-all-ref` also bind their last variable to the exception itself,
  an `exnref`, which `throw-ref` throws again. The clause runs after the
  exception has left the body, so an exception from the clause goes to
  the code around the `try`. The words of the clauses are compared by
  name. A `try`'s value is its body's or the clause's, typed as the
  branches of an `if` are. A call in the body is not a tail call, which
  would leave the `try`. This is wasm's `try_table`, whose catches branch
  to blocks that the clauses follow.
- A call in tail position whose callee's result types fit the function's
  is emitted as `return_call`, so recursion in tail position runs in
  constant stack.
- Loads and stores take an optional trailing literal offset:
  `(i32.load p 8)`, `(i32.store p v 8)`.
- Labels are bindings and obey scope like variables.
- **`lambda`** is a function that uses the locals around it: its body
  reads and assigns them, and each side sees the other's assignments. Its
  parameters and result are written as a `func`'s. Its body cannot branch
  to the labels around it, and `return` in it returns from the `lambda`.
  A `lambda` is a **closure**, a GC struct whose first field is its code: a
  module-level function of the closure and the parameters, which the
  compiler lifts. The **closure type** of a signature, written `(closure
  (t ... -> r ...))` in a type position, is the type of every `lambda` of
  that signature: it and its code's type are one recursion group, so two
  modules that write it write one type (5.1). A `lambda` that captures
  variables is of a final subtype of it, with a field per variable holding
  its value. A captured variable that is also assigned is held in a
  **box**, a struct of one mutable field, which the `lambda` and the code
  around it share. A variable bound to a `lambda` and only ever called,
  such as a loop, is a **known function**: its code takes what the
  `lambda` captures as parameters after its own, its calls are direct
  calls, tail calls in tail position, and no closure is made. An
  application whose head is not a function's name, `(#%app e arg ...)`,
  applies the function value `e`, whose type must be a closure type: it
  calls the closure's code, with `return_call_ref` in tail position. The
  head may be a variable `x`, `(ref.cast (ref C) x)`, or, as a language
  that must check a value before applying it writes, `(if (ref.test (ref
  C) x) (ref.cast (ref C) x) e)` with `e` not using `x`: each is a call of
  `x`, and a known function of that signature stays one. A language
  chooses its calling convention by the signatures it writes. A language
  may also turn its lambdas into something else before the kernel sees
  them: Substrate's lowering makes its closures nodes in memory
  (`lib/substrate/lower.sub`), so its programs need no GC.
- **Application is an implicit form**, as in Racket. A form whose head is
  not bound to a macro, a core form or a wasm operator, including one
  whose head is not an identifier, is expanded as `(#%app head arg ...)`.
  The `#%app` identifier gets the scopes of the form, so it means what
  `#%app` is bound to where the form was written, not where it is
  expanded. A module changes the meaning of its applications by binding
  `#%app` to a macro, usually by importing one, as a module written in
  Substrate does. Code a macro introduces keeps its own module's `#%app`.
  The core `#%app` calls a function directly, and applies anything else as
  a function value, which the language lowers (above). A macro standing
  for `#%app` must not return an application written with the use's
  scopes, which would expand through it again; one written with its own
  module's scopes uses that module's `#%app`. Wasm operators are not
  applications and never go through `#%app`.

### 5.4 Literals

A literal is an implicit form too: `42` is expanded as `(#%datum 42)`,
where `#%datum` gets the scopes of the literal (5.3). Racket writes this
`(#%datum . 42)`; the kernel uses a proper list. The core `#%datum` makes
unquoted literals wasm numbers, as the table below says. A module that
binds `#%datum` to a macro gives its literals another meaning, such as
data, while the literals in other modules' macro templates keep theirs.
The macro must not return a bare literal written with the use's scopes,
which would expand through it again.

`quote` turns a literal into a datum. Data are the kernel module's, so a
linklet that quotes imports from the kernel module and takes its memory
(3.3). At phase 0 that is visible in what the program imports, and
`(freestanding)` rejects it (3.4).

| Source | Unquoted | Quoted |
|---|---|---|
| `42` | integer constant, type from context | fixnum or integer datum |
| `1.5` | float constant | flonum datum |
| `#\a` | `i32` 97 | character datum |
| `#t` / `#f` | `i32` 1 / 0 | `#t` datum / `#f` |
| `"text"` | error: use `data` for bytes | string datum |

The unchanged parts of a `quasisyntax` template keep their lexical
context, which is what macro templates need. The reader abbreviations are
`'` `` ` `` `,` `,@` and `#'` `` #` `` `#,` `#,@`. The reader reads `#%name`
as the symbol `#%name`, and `#:name` as a keyword, as Racket does: a kind
of datum of its own, used for options in forms such as `#:inline`. A
keyword is not an expression, but quoted it is a datum. A number literal
is an integer or a decimal. An integer is an optional sign and digits, or
`#x`, `#b`, `#o` or `#d` and an integer in that radix, and must fit in 64
bits, from -2^63 to 2^64 - 1. A decimal has a point, an exponent or both,
or is `+inf.0`, `-inf.0`, `+nan.0` or `-nan.0`. A fraction, such as `1/2`,
is an error, and any other token is a symbol. A decimal is the f64
nearest its exact value, ties to even: infinity above the largest f64,
and zero below half the smallest.

### 5.5 Base bindings

Every module sees, at every phase, only the kernel forms, including the
core `#%app` and `#%datum`, and the wasm numeric and memory operators.
Everything else comes from a declaration in the module: its own
definitions, `import`, and `require`.

## 6. Expansion

### 6.1 Binding

Binding follows Flatt's sets of scopes. Every binding form (`func`, `let`,
`let*`, `block`, `loop`) creates a fresh scope and adds it to the syntax it
governs. A binding is recorded as (symbol, scope set, phase, namespace)
and maps to a key. An identifier refers to the binding whose scope set is
the largest subset of its own. If there is no unique largest subset, the
reference is an error.

- **Namespaces.** Types are bound in the type namespace and everything
  else in the value namespace. Positions that take a type (`(ref T)`, the
  `T` of a GC instruction, a supertype) look up types; all others look up
  values. So one name can be both, as a struct library needs for a type
  and its constructor or compile-time value.
- Core bindings have the scope set `{0}`, which every module body carries.
  A module's own definitions have more scopes, so they shadow core names.
- A module-level definition of a name that is already defined with the
  same scope set at the same phase is an error, and so is a local binding
  form that binds one name twice, reported where it binds it again. So is
  a reference whose best candidates have identical scope sets but
  different meanings.
- **Bindings outlive a module's compilation.** The binding table and scope
  ids last for the whole compiler run. A macro's template identifiers
  carry its module's scopes, so they keep resolving to its module's
  bindings, including ones it does not provide, when another module
  expands them.
- **Lookup.** The table keeps each binding under the greatest (most
  recently made) scope of its set. An identifier can refer to a binding
  only if it has that scope too, so resolving an identifier looks only
  under its own scopes, not at every binding of its symbol.
- **Propagation.** Adding, removing or flipping a scope on a syntax object
  makes the same change to every syntax object inside it. The object's own
  scopes change at once. The change to its datum is recorded as pending,
  and made one level down the first time something looks inside
  (`syntax-e`), so the syntax objects nothing looks inside are never
  rebuilt, and changes that cancel, like the two flips of a macro's
  introduction scope, are never made.
- **Phases.** Bindings are recorded per phase, and a syntax object has one
  scope set. A module required at phase shift *s* ≠ 0 has its bindings
  installed at their phase + *s*. In their scope sets, each module scope,
  whether the module's own or another module's that a macro's template
  gave a definition, is replaced by that module's copy for the phase shift
  + *s*. So a module required at two phase shifts, which has bindings from
  both at the same phase (a macro `m` shifted up, next to the phase-1
  function behind `m`), keeps them apart. The syntax literals a linklet
  builds when instantiated at phase shift *t* are shifted the same way:
  every module scope in them, module *X*'s copy for phase shift *s*,
  becomes *X*'s copy for *s* + *t*. A literal can hold other modules'
  scopes as well as its own module's, for example when another module's
  macro wrote part of its code. Only module scopes shift; introduction and
  use-site scopes, and the core scope, mean the same at every phase. This
  is Racket's per-phase module scopes, applied eagerly per phase shift.
  The shift is made through the linklet's scope table (3.5): the compiler
  maps each module scope in it to the copy for the phase shift, and every
  other scope to itself.

### 6.2 Hygiene

Each macro use gets a fresh **introduction scope**. The expander flips it
on the syntax it passes to the transformer and again on the syntax that
comes back. Parts of the result that came from the input lose it; parts
the transformer introduced, such as template identifiers, keep it. So a
binding the macro introduces cannot capture the user's identifiers, and
the user's bindings cannot capture the macro's.

A use in a **definition context** of a macro defined in that same context
also gets a fresh **use-site scope**, added to its input and not removed.
In v0 the definition contexts are module bodies, at any phase. There the
use site and the macro's definition share the module's scopes, and the
use-site scope keeps them apart: without it, a local binding made from
the macro's input could capture a reference the macro introduced. A macro
from another module needs none, since its introduction scope keeps what
it introduces apart; so the templates of a module share its scopes
whatever macro, such as a language's `define`, they are written in (see
the literals below). Use-site scopes are removed from the name of every
module-level definition, so a definition a macro makes from its input is
visible to the rest of the module.

This is the same trade Racket makes: a module-level *definition* made
from a macro's input can still capture the macro's own references to that
name. Local bindings cannot.

A transformer can capture on purpose: `(datum->syntax stx 'it stx)` makes
an identifier with the scopes of the use, as if the user had written it.

**Output takes the use's location.** If the outermost syntax object of a
macro's output comes from another file than the use, as a library macro's
template does, it takes the use's source location, so errors in it and
code compiled from it are located where the macro was used (3.6). The
forms of a module-level `begin` are spliced, each of them output too:
each that comes from another file than the `begin` takes its location.

**Literals drop local scopes.** `quote-syntax` and the constant parts of
`quasisyntax` remove from their literal the scopes of local binding forms
(`func`, `let`, `let*`, `block`, `loop`), keeping module, introduction and
use-site scopes. So every template in a module has that module's scopes,
whatever function or `let` it is written in, and a macro can assemble its
output from templates built by different helper functions: an `x` bound
by one refers to the `x` in another. This is Racket's `quote-syntax`
without `#:local`. The kernel has no local macros, so a literal never
needs a local scope.

### 6.3 Compile-time bindings

`(define-syntax s expr)` binds `s` at compile time: `expr` is run at
phase+1 now (3.1), and `s` is bound to its value, a datum (2.2), a
**compile-time value**.

- If the value is a transformer (2.1), `s` is a macro. The expander checks
  when `s` is used, since only then is the value known to it.
- Otherwise using `s` as an expression is an error, but macros read the
  value with `syntax-local-value`. This is how extensions share
  information, for example a struct form and a match form.
- `(define-syntax m f)`, where `f` names a phase+1 function of type
  `(i32) -> i32`, binds `m` to a transformer that calls `f`. A function
  name is not an expression, so this is a form of its own. `f` may come
  from a module required inside `begin-for-syntax`.
- The value must be a datum. A GC value, such as a `lambda`, is an error.

The value lives in a global of the phase+1 linklet, so another module
that requires this one computes it again in its own compilation.

### 6.4 Fully expanded code

Expansion turns a module into **fully expanded code**, as Racket calls it:
syntax in the grammar below, with every macro use expanded and every
application and literal explicit. `local-expand` returns it and `sub
expand` prints it. The compiler's input is not syntax: expansion builds
that input as it goes, and builds fully expanded code only where a macro
or `sub expand` asks for it.

```
form ::= (func (id [id type] ...) [#:inline] [#:value id] [-> result] [(type id)] expr ...)
       | (global id type expr) | (global id (mut type) expr)
       | (import id "module" "field" (type ... -> type ...)) | (import id "module" "field" id)
       | (type id def) | (rec (type id def) ...) | (data id offset "bytes" ...)
       | (tag id (type ...))
       | (#%fact id (quote datum))            ; a fact about id's definition (6.5)
       | (#%fact id (quote-syntax datum))
       | expr

expr ::= id                                   ; a local or global variable, or a function
                                              ; with a value (5.2), which means its value
       | (#%datum literal)                    ; a wasm number, typed by context
       | (quote datum) | (quote-syntax datum)
       | (#%app id expr ...)                  ; a direct call; id names a function
       | (#%app expr expr ...)                ; an application of a function value (5.3)
       | (op expr ... [offset])               ; a wasm numeric or memory operator
       | (gc-op immediate ... expr ...)       ; struct.new, ref.cast, ... (5.3)
       | (let (binding ...) expr ...) | (values expr ...)
       | (lambda ([id type] ...) [-> result] expr ...)
       | (set! id expr) | (begin expr ...) | (if expr expr [expr])
       | (block id expr ...) | (loop id expr ...)
       | (br id [expr]) | (br-if id expr) | (br-table (id ...) id expr) | (return [expr])
       | (call-indirect (type ... -> type ...) expr expr ...)
       | (ref.func id) | (call-ref id expr expr ...)
       | (func-index id) | (data-address id) | (data-size id)
       | (i32.const n) | (i64.const n) | (f32.const x) | (f64.const x)
       | (select expr expr expr) | (drop expr) | (unreachable) | (nop)
       | (throw id expr ...) | (throw-ref expr) | (try (clause ...) expr ...)

binding ::= [id expr] | [id type expr] | [(id ...) expr] | [(id ...) (type ...) expr]

clause ::= (catch id (id ...) expr ...) | (catch-ref id (id ...) expr ...)
         | (catch-all expr ...) | (catch-all-ref (id) expr ...)
```

- The other module-level forms (`require`, `provide`, `memory`, `table`,
  `freestanding`, `define-syntax`, `begin-for-syntax`) take effect during
  expansion and leave nothing. `let*` becomes nested `let`s. `quasiquote`
  and `quasisyntax` become calls to the kernel module's functions, through
  identifiers with a scope of their own that no module's code has, so user
  code cannot name them.
- Each local variable, at its binder and at each use, records its
  binding, which `local-binding` reads (2.3).
- Types appear where the source wrote them: parameters, results, globals,
  and `let` bindings that give one. Fully expanded code carries no
  inferred types; the kernel's checker infers them when it compiles, as
  it does for any code. Type functions (5.1) are expanded: types in fully
  expanded code contain no macro uses.
- **Quoted data is left as it is**: `(quote datum)` expands to itself,
  whatever `datum` holds, syntax included. So a macro can leave, where an
  expression goes, what a macro that expands the code later needs to
  know. The C-like Lisp leaves marks such as `'(#%c-inst g (T ...))`, an
  instance of the generic function `g` at the types `T ...`, which the
  macro that checks a function's body replaces (`compiler/base/lang.sub`).
- **The core forms in fully expanded code are named by identifiers with
  only the core scope**, so they mean the core forms in any module,
  whatever it binds, for example its own `let` or `#%app`. Every other
  identifier keeps its scopes and resolves as before.
- **Fully expanded code can be expanded again**, with the same meaning.
  Its binding forms bind again under fresh scopes, which the references
  inside them get too. So a macro can put `local-expand`'s result into its
  output.
- **Lifted definitions** (`syntax-local-lift-definition`, 2.3) are declared
  as soon as they are lifted, so their names can be used at once, and
  their fully expanded code goes before the module-level form whose
  expansion lifted them.

### 6.5 Facts

`(#%fact id 'datum)` and `(#%fact id #'stx)`, module-level forms, record
`datum`, as data, or `stx`, as syntax, unevaluated, as a **fact** about the
definition `id` refers to. They bind nothing. A language records facts
where finding things by name will not do: Bend records each definition's
terms and the name of its function as facts about the definition
(`lib/bend/bend.sub`), and Substrate records which parameters a function
borrows (`lib/substrate/lower.sub`). Data can name definitions too (6.6).

- A fact is about a **definition**: a module's function, global, tag or
  compile-time value, made before the fact. Every identifier that refers
  to that definition sees its facts: under another name, as a qualified
  import, and at another phase shift. Core forms, locals and the kernel
  module's definitions, which every language shares, have none.
- `(syntax-local-facts id)` returns the facts about `id`'s definition at
  the running macro's phase: those recorded so far by the module being
  expanded, and those of every module it requires, directly or not. Each
  is `(module phase value)`: the file of the module that recorded it, the
  phase it recorded it at, and the datum or syntax. A module's facts come
  after those of every module it requires, in the order of its requires,
  and each module's in the order it recorded them; a module required more
  than once counts once for each phase shift. So a fact can override one
  of a module its module requires, if the language that reads them says
  so.
- A module required at phase shift *s* has its facts at their phase plus
  *s*, as its bindings are (6.1).
- A fact's datum or syntax is data the module keeps, not code: its
  interface holds its facts (3.7). Syntax in a fact seen at a phase shift
  has its scopes shifted, as a linklet's literals are (3.5).
- A fact is a claim a language made, not a checked one: a language that
  checks what facts say, such as a proof checker, derives it again.

### 6.6 Names

A definition has a **name**, a symbol that is data: a language can keep it
in a datum, such as a term or a type, compare it with `==`, hash it, and
quote it, where an identifier, which is syntax, could not go. Bend's terms
name the definitions they refer to this way (`lib/bend/core.sub`).

- `(identifier-name id)` resolves `id` at the running macro's phase and
  gives the name of the definition it refers to: a module's function,
  global, tag or compile-time value, as a fact is about (6.5), whatever
  name, module or phase shift it is seen under. It is `#f` for locals,
  core forms and the kernel module's definitions.
- A name is `file:symbol`, with the file named as in 3.6 and the
  definition's own symbol, then `@p` for a definition at phase *p* of its
  module and `#n` for the *n*-th definition of that symbol at that phase
  in the module, counting from 0, in the module's order: hygiene can make
  several, such as a macro's that each use defines. So a name depends only
  on the module's source.
- `(name-identifier name)` gives an identifier that refers to the
  definition `name` names, at the running macro's phase, as an identifier
  from the defining module's own code would: its symbol with its scopes,
  at the phase shift its module is required at. The definition must be
  the module being expanded's, made so far, or that of a module it
  requires, directly or not, as for facts; otherwise it is an error. So a
  name reaches what the module depends on, which its hash covers (3.2),
  unexported definitions included, and nothing else. With it,
  `syntax-local-value`, `local-expand` and `syntax-local-facts` take a
  name.

## 7. Open questions and later milestones

- **Controlling expansion.** A language cannot change how a module body
  expands, as Racket's `#%module-begin` can. What needs the whole module
  waits for the second pass (5.2), as Substrate's borrow inference does.
  Nothing planned needs more.
- **Kernel types that fully expanded code leaves out.** Fully expanded
  code carries only the kernel types the source wrote (6.4), and the
  kernel infers the others when it compiles. A typed language does not
  need them: it gives every variable its own type and derives the kernel
  types it writes from those, as the C-like Lisp does.
- **Isolating compile-time code.** Compile-time code shares the compiler's
  memory, allocator and stack (1.3), which is what makes syntax objects
  cheap to pass. Compiling untrusted code safely needs a separate compiler
  instance today. A boundary inside one compiler would give compile-time
  code its own memory and reach syntax only through the kernel module's
  functions, at some cost to macro speed.
- **Locations inside another module's generic instance.** An instance of
  a generic function that the C-like Lisp makes in another module is
  located at the generic's definition, but the lines within it are not
  reported, because the compiler replaces a location from another file by
  the nearest enclosing one (3.6). An instance's own file should count as
  its file, which is a change to 3.6 and to the compiler's back end.

## Appendix A: the kernel module's representation (not part of the contract)

This describes `compiler/kernel.sub` as it is. Macros must not depend on
it; the compiler may, because it is part of the expander.

- **Data.** A datum is an `i32`: 0 is `#f`, an odd number is a fixnum, and
  anything else is the address of a cell. A cell is one of:

  | Cell | Fields |
  |---|---|
  | pair | `car`, `cdr` |
  | empty | none: the one cell `nil` |
  | true | none: the one cell for `#t` |
  | symbol, keyword | the name's bytes and length, and the next interned symbol or keyword whose name has the same hash |
  | string | its bytes and length |
  | integer | its 64 bits, low then high, and whether it is negative |
  | flonum | its 64 bits, low then high |
  | character | its code |
  | syntax | its datum, scope set, source location, properties and pending scope changes |
  | record | a kind and a pointer: a datum that stands for a struct of the caller's |
  | transformer | its code (a table index), its environment, and whether the code takes the environment |

- **Syntax objects** are wrapped eagerly: the datum of a list is a list
  whose elements are syntax objects. A scope is a number below 2^30, and
  scope 0 is the core scope. A scope set holds its scopes greatest
  (newest) first, and is interned, so two sets of the same scopes are the
  same pointer. The result of a change to a set is remembered, so the same
  change to the same set is worked out once. Pending changes (6.1) are a
  list of changes, each a scope and a kind: 0 to add, 1 to remove, 2 to
  flip. `syntax-e` makes them on the syntax objects inside and empties the
  list. A source location is a file, a symbol, as errors name it; a line
  from 1; and a column, position and span from 0. Properties are a list of
  `(key . value)` pairs, newest first, with each key at most once. The
  expander records a local variable's binding in the property
  `%local-binding`.
- **Arenas.** Cells live in arenas, by how long they last. The run's arena
  holds what lasts the whole run: symbols, keywords, scope sets, and what
  `keep` copies there, which is what the expander keeps after a module's
  compilation. Each module's compilation has an arena of its own, freed
  when the module is compiled; the arenas of modules nest as compilations
  do. Cells are made in the current arena, which `use-arena` changes. No
  syntax object in the run's arena has changes pending.
- **Compile errors** are thrown with the tag `compile-error`, carrying the
  message, the syntax blamed (or `#f`) and a source location (or 0).
- **Queries.** The compiler registers the functions that answer the
  queries (2.3) with `set-queries!`. Until it does, each query traps.
- **Quoted data and compiled files.** The byte format is
  `compiler/serialize.sub`'s. `deserialize` reads it into the current
  arena, after `literal-buffer` has made room for the bytes. Interfaces
  and compiled files (3.7) are data in the same format.
- **Literal scopes.** A linklet's literals hold scope indexes (3.5).
  `set-scope-map!` gives the kernel module the run's scope for each index,
  a module scope's copy for the phase shift among them (6.1), before the
  compiler instantiates a linklet at compile time. Without a map, the
  indexes stay.
