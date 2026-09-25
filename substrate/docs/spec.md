# Substrate kernel specification (v0 draft)

Substrate is a Lisp over WebAssembly. This document specifies its kernel,
whose one real addition to wasm is compile-time execution: macros are
ordinary kernel code, compiled to wasm and run by the same engine that runs
programs. The aim is that different languages can be built as libraries
over one small kernel, and that the code they produce carries no runtime
it did not ask for. The language most code is written in, also called
Substrate, is one such library (`lib/substrate.sub`), as `racket/base` is
built over Racket's `#%kernel`.

Status markers: **[v0]** is implemented by stage0 now, **[planned]** is
specified but not built yet.

## 1. Principles and architecture

### 1.1 Principles

1. **The kernel is wasm with names, plus compile-time execution.** "Wasm" is
   Wasm 3.0, including reference types and GC. The kernel adds no memory
   model and no runtime of its own.
2. **Pay as you go.** Compiled code contains only what its code uses. A
   module can declare that it needs nothing beyond the host at run time,
   and the compiler checks the declaration after expansion (3.4).
3. **Phases are uniform.** The language is the same at every phase. Code
   requires the libraries it uses, at the phase that uses them, and each
   phase gets its own instances.
4. **Syntax belongs to the expander.** Macros create and inspect syntax
   only through the syntax library's functions (section 2). At compile time
   they link to the running compiler's instance of that library, so its
   interface is part of the bootstrap seed.
5. **The compiler is an ordinary program.** After bootstrap it requires the
   syntax library at phase 0, as any program that transforms code would.

### 1.2 Components

| Component | What it is | Where |
|---|---|---|
| host | Creates stores, links instances by name, provides the instantiate hook and I/O (section 4). Owns no memory. Permanent: after bootstrap it runs the self-hosted compiler. | `host/subhost.c` (C, over wasmtime), `host/subhost.mjs` (JavaScript, over Node's V8) |
| compiler | Reader, expander, kernel compiler, binary encoder. | `compiler/*.sub` (Substrate); stage0, the bootstrap compiler: `stage0/*.sls` (Chez Scheme) |
| syntax library | Syntax objects and the data inside them, as wasm GC objects, and the functions of section 2. After bootstrap it is part of the self-hosted compiler. | `compiler/syntax.sub` (kernel code) |
| libraries | Ordinary modules: printing, `define-macro`, structs and `match`. | `lib/*.sub` |
| languages | Libraries that make a language, such as Substrate. | `lib/substrate.sub` |

### 1.3 What runs where

| | While compiling | While a program runs |
|---|---|---|
| the syntax library | always instantiated in each compile-time store; macros link to it | instantiated only if the program's linklets import it |
| GC | syntax data lives in the engine's GC heap | only if the program's code uses GC types or the syntax library |
| each module's memory and table | its own, if it defines them | its own, if it defines them |
| the host | no memory of its own; reads and writes the caller's | same |

A **store** is one wasm store with one linker. Each module is compiled
with its own **compile-time store**, which holds the syntax library, the
linklets the module's compile-time code runs in, and the linklets of what it
requires (3.2). A **run-time store** holds the linklets a program loads.

The compile-time environment is garbage collected: syntax objects are GC
objects. A compiled program is garbage collected only if its own code uses
GC types or requires the syntax library.

### 1.4 Bootstrap

The compiler is written in Substrate (`compiler/*.sub`, the syntax library
among them). Stage0, a compiler of the same language written in Chez
Scheme (`stage0/`), builds it: that build is **stage1**. Stage1 builds the
compiler from the same source (**stage2**), and stage2 builds it again
(**stage3**). The bootstrap reaches its **fixpoint** when stage2 and stage3
are the same bytes, and so is the syntax library each writes: the compiler
reproduces itself exactly. That needs compilation to be deterministic,
which is why the host gives programs no clocks or randomness (section 4).
While stage0 is kept, stage1 = stage2 too: two compilers written apart, in
different languages, write the same bytes. `make bootstrap` builds the
stages and checks both.

## 2. The macro contract

### 2.1 Transformers

A **transformer** is a value the expander calls with the syntax object for
a macro use (the whole form, or the identifier alone); it expands the
syntax object the call returns. `(make-transformer code env)` makes one:
`code` is a function reference of type `(func (eqref eqref -> eqref))`,
called with `env` and the syntax. Types are identified by structure
(5.1), so a module that makes transformers declares that function type
itself and gives its code function the type with a `(type T)` clause. A
name that `define-syntax` binds to a transformer is a **macro** (6.3).
`(define-syntax m f)`, where `f` names a phase-1 function of type
`(eqref) -> eqref`, binds `m` to a transformer that calls `f`.

### 2.2 Values

The syntax library represents data as **values** of wasm type `eqref`.
The contract promises this about them:

- `#f` is the null reference, so `(ref.is_null v)` tests for it.
- `ref.eq` is identity. Symbols and keywords are interned, so two with the
  same name are `ref.eq`. Small integers (fixnums) are `ref.eq` when they are
  equal. Characters, strings, larger integers and flonums are not
  guaranteed to be `ref.eq`; compare characters and strings with
  `char->integer` and `string=?`, and numbers by their values.
- Everything else about the representation is private (appendix A).

Counts, indices, bytes and predicate results are `i32`, not values:
`(length l)` is an `i32` count and `(pair? v)` is 1 or 0. Because values
are references, wasm's own type checking keeps them apart from numbers.

### 2.3 Functions

`(require name syntax)` binds these as `name:function` at the phase where
it appears, plus any it lists to bind unqualified (3.1). They are imported
from the instance `"syntax"`. Parameters are `eqref` unless marked with
another type, such as `n:i32`.

| Group | Functions |
|---|---|
| atoms | `(fixnum n:i32)`, `(fixnum-value v) -> i32`, `(fixnum? v) -> i32`, `(integer n:i64)`, `(integer? v) -> i32`, `(integer-value v) -> i64`, `(integer-negative? v) -> i32`, `(flonum x:f64)`, `(flonum? v) -> i32`, `(flonum-value v) -> f64`, `(char? v) -> i32`, `(char->integer c) -> i32`, `(integer->char n:i32)`, `(boolean? v) -> i32`, `(null? v) -> i32` |
| lists | `(cons a d)`, `(car p)`, `(cdr p)`, `cadr`, `cddr`, `caddr`, `cdddr`, `(pair? v) -> i32`, `(list? v) -> i32`, `(length l) -> i32`, `(append a b)`, `(reverse l)` |
| strings and symbols | `(string? v) -> i32`, `(string-length s) -> i32`, `(string-byte s i:i32) -> i32`, `(string=? a b) -> i32`, `(string-append a b)`, `(make-string-builder)`, `(string-builder-add-byte! b byte:i32)`, `(string-builder-add! b s start:i32 end:i32)`, `(string-builder->string b)` (a new string, or `#f`), `(symbol? v) -> i32`, `(symbol->string s)`, `(string->symbol s)`, `(symbol-append a b)`, `(symbol-hash s) -> i32`, `(keyword? v) -> i32`, `(string->keyword s)`, `(keyword->string k)` |
| syntax | `(syntax? v) -> i32`, `(syntax-e s)`, `(identifier? v) -> i32`, `(syntax->list v)` (a list, or `#f`), `(syntax->datum v)`, `(datum->syntax ctx d loc)`, `(syntax-rewrap s e)`, `(splice-list v)`, `(syntax-property s key)` (the value, or `#f`), `(syntax-property-set s key value)`, `(local-binding id)` (a fixnum, or `#f`) |
| transformers | `(make-transformer code:(ref (func (eqref eqref -> eqref))) env)` |
| queries | `(syntax-local-value id)` (the compile-time value `id` is bound to, a macro's transformer included, or `#f`), `(raise-syntax-error name message stx)` (aborts expansion; returns nothing), `(free-identifier=? a b) -> i32`, `(identifier-binding-kind id)`, `(identifier-function-signature id)`, `(local-expand stx)`, `(syntax-local-lift-definition form)` |

- **Numbers.** An integer literal is a fixnum if it fits in 31 bits, and
  otherwise an integer value; integers run from -2^63 to 2^64 - 1, as
  wasm's constants do, and are kept exactly. `integer?` holds for both
  kinds. `integer-value` is the value's 64-bit two's complement, what
  arithmetic wants, and with `integer-negative?` it gives the exact value:
  a non-negative one is `integer-value` read as unsigned. `integer` makes
  the fixnum or integer value for a signed `i64`. A decimal literal is a
  flonum, an `f64`.
- **Strings** are immutable UTF-8, and their lengths and indexes count
  bytes. A string builder collects bytes, singly or as a range of a
  string's, and `string-builder->string` makes a new string of them, or
  `#f` if they are not UTF-8, so every string is.
- `syntax-e` of an identifier is a symbol, and of a literal it is the
  literal's value. Of a list it is a list whose elements are syntax.
- `datum->syntax` wraps a value, giving every new syntax object the scopes
  of `ctx` and the source location of `loc`, each a syntax object or `#f`
  for none. As in Racket, the two are separate: a macro usually takes
  scopes from its own templates or the use, and the location from the part
  of the input the new syntax stands for, so errors in the code it builds
  point at code the user wrote.
- `syntax-rewrap` copies syntax object `s` around a new datum `e`, keeping
  its scopes, source location and properties. `quasisyntax` is built on it.
- **Properties** attach values to a syntax object, for example a type a
  macro computed for it. `syntax-property-set` returns a copy of `s` with
  `key` set; keys are compared with `ref.eq`, so symbols make good keys.
  Scope operations (6.2) do not reach into property values. The expander
  keeps a syntax object's properties when it adds or removes scopes, but
  does not copy the properties of a macro use onto the macro's result.
  [v0] Stage0 can keep only syntax-library data in properties; a macro that
  returns syntax holding another GC object is an error.
- `local-binding` identifies the local variable that identifier `id`
  binds or refers to in fully expanded code (6.4): a fixnum, the same at
  the variable's binder and at each use and different for every local
  variable in the compilation. It is `#f` for anything else, such as a
  global, or an identifier that is not in fully expanded code. A pass uses
  it to tell which binder a variable refers to, as `free-identifier=?`
  would, but without asking the expander.
- Accessors trap with a message ("expected a pair") when given the wrong
  kind of value.
- `free-identifier=?` is 1 when `a` and `b` refer to the same bindings at
  the running macro's phase, as a value and as a type (6.1). An imported
  name and the definition it imports are the same binding. Two identifiers
  bound in neither namespace are equal when their names are.
- `raise-syntax-error` is Racket's: it aborts expansion with `message`,
  a string, blamed on `stx`. The message is prefixed with `name: `, or if
  `name` is `#f` with the name `stx` gives: an identifier's own, or that
  of the identifier heading a list. A macro that blames part of its input
  passes its own name.
- `identifier-binding-kind` says what identifier `id` is bound to as a
  value at the running macro's phase: the symbol `function`, `variable` (a
  local or global), `macro` (a compile-time value that is a
  transformer), `compile-time-value` (any other), `data`, `label` or
  `core` (a core form or wasm operator); `type` if it is bound only as a
  type; or `#f` if it is unbound. An implicit `#%app` (5.3) uses it to tell
  a call of a function from a call through a variable.
- `identifier-function-signature` gives the signature of the function
  `id` is bound to at the running macro's phase, as the datum
  `(t ... -> r ...)`, each type written as in the kernel: a numeric type's
  name, or `(ref T)` or `(ref null T)` with `T` a heap type's name. It is
  `#f` if `id` is not bound to a function. An implicit `#%app` uses it to
  tell whether a call gives a function the arguments it takes.
- `local-expand` expands expression `stx` at the running macro's phase and
  returns it as fully expanded code (6.4), so a macro can look at what its input
  becomes, and put the result in its output. As in Racket, the macro's
  introduction scope is flipped around the expansion, so code from the
  macro's input expands as it would at the use site.
- `syntax-local-lift-definition` adds a module-level form (a `func`, `global`,
  `import`, `type` or `data` form, or an expression) to the module body
  being expanded, at the running macro's phase (6.4). It returns the form
  as it is declared: with the macro's introduction scope, like the
  macro's output, so each use gets fresh names.

The queries only work while an expander is running. [v0] Stage0 answers
them in Chez; in a run-time store they trap.

## 3. Modules, linklets and linking

### 3.1 Modules and linklets

- One source file is one module. A module's code at one phase compiles to
  one wasm module, called a **linklet**, as in Racket. Phase 0 is the
  program. Phase *n*+1 code runs while phase *n* is expanded, so a module's
  phase-1 linklet holds its transformers, its compile-time values and its
  `begin-for-syntax` code.
- `(provide item ...)` names the phase-0 bindings other modules get:
  functions, globals, macros, compile-time values, types and data, whether the
  module defines them or imported them. An item `x` provides `x`, and
  `[new old]` provides `old` under the name `new`. A name bound both as a
  type and as a value provides both. One name cannot be provided for two
  different bindings.
- `(require name source item ...)` imports what another module provides.
  `source` is `"path"` (relative to the requiring file) or `syntax` (the
  syntax library, section 2).
  - Everything the source provides is bound **qualified**, as
    `name:thing`. Nothing is imported unqualified by default.
  - Each item also binds one thing unqualified: `x` binds `x`, and
    `[new old]` binds `new` to the source's `old`, in `let` order.
  - `(require-unqualified name source)` is `require` with every name the
    source provides bound unqualified too, with the scopes of `name`. It
    is meant for a language: the forms and functions its code is written
    in, such as its `define`, `#%app` and `#%linklet` (6.5), and little else, since
    unqualified names hide where a binding comes from. As in Racket, where
    a module's definitions shadow its language's bindings, a module-level
    definition of one of these names shadows the import throughout the
    module. It is an error if a macro use in the module relied on the
    import before the definition, since that expansion cannot be undone.
  - A require at phase *p* imports at phase *p*. To import for compile-time
    code, put the require inside `begin-for-syntax`. The required module's
    phase *q* is then phase *p* + *q* in the requiring module.
  - Requiring the same module again is harmless; a name that already names
    another module at that phase, and cycles, are errors.
  - Qualified names are ordinary identifiers: `print:write-int` is one
    symbol. An import binds the name in each namespace the source provides
    it in (6.1). Binding a name twice in one namespace at the same phase,
    by definition or import, is an error.
- Expansion must run phase-1 code before the module is finished: a macro
  works on the line after its definition. So while a module is expanded,
  each `begin-for-syntax` and each `define-syntax` is compiled into a
  linklet of its own and instantiated at once, in
  source order, as Racket evaluates them. When the module is done, each
  phase's code is compiled again as a whole, into the module's linklet for
  that phase. Other modules only ever use those.

### 3.2 Stores and instance names

- The compilation of each module has compile-time instances of its own.
  The linklets of the module's compile-time code, and those of the modules
  it requires, are instantiated for it on demand. So no compile-time state
  is shared between the compilations of two modules, as in Racket.
  Compiled wasm code is not state: the host compiles a linklet's bytes once
  and instantiates the result wherever it is needed. [v0] Stage0 gives
  each compilation a fresh store. The self-hosted compiler runs in a store
  of its own and gives each compilation a namespace in it (below), since
  macros share syntax objects with the compiler by reference.
- A module's linklet instantiated at phase shift *t* is registered as
  `<module>@<phase>+<t>`. A compiled linklet imports from other linklets by
  names relative to its own module at phase shift 0. The host adds the
  phase shift when it instantiates the linklet (section 4), so one compiled
  linklet serves at any phase.
- A program runs in a fresh run-time store holding exactly the linklets
  reached from its phase-0 linklet at phase shift 0. A module required
  only inside `begin-for-syntax` is never loaded at run time.
- The other instance names are `syntax`, `host`, `expander`, the linklets
  of compile-time code (`<module>@<phase>#<n>`) and per-store entry
  linklets (`entry#<n>`).
- **Namespaces**: an instance registered as `<ns>/<name>` imports from
  linklets, the instances with an `@` in their names, in namespace `ns`:
  the host looks up `<ns>/<linklet>`, after the phase shift. Its other
  imports, such as `syntax` and `host`, are the store's.

### 3.3 Linking

- **A module imports only what its code uses.** Nothing is bound or
  imported by default. Code that calls a required module's functions
  imports from that module's linklet. Code that calls the syntax library, or
  uses `quote`, `quasiquote`, `quote-syntax` or `quasisyntax`, imports from
  `"syntax"`.
- **A module owns its memory and table, or takes them from a module it
  requires.** `(memory pages)` defines memory 0. `(memory from name)`
  imports the memory of the module required as `name` at the same phase, so a
  program's modules can share one memory. Tables likewise. Code that uses
  memory instructions or data segments needs a memory, and code that uses
  `func-index` or `call-indirect` needs a table. At phase ≥ 1 these work the
  same way. There the compile-time linklets of a phase (3.1) share one
  memory: the first linklet after `(memory pages)` defines it and later
  ones import it, so, as with macros, code can use it only after the
  declaration. Tables likewise.
- A linklet exports its memory as `"memory"` and its table as `"table"` (the
  host relies on this, section 4), and every module-level function and
  global under its name. If two bindings share a name, the compiler appends
  `.<n>` to later ones.

### 3.4 Freestanding modules

`(freestanding)` declares that the program needs nothing beyond the host at
run time, in the sense C, Zig and Rust give the word: no run-time library.
After expansion, the compiler checks every linklet the program would load:
each may import only from the host and from the program's other linklets,
and none may use GC types. The check runs after expansion because
macros can add dependencies the program never wrote.

### 3.5 Initialization

A global whose initializer is a constant expression (5.2) gets it as its
wasm initializer. The others start at their type's default, zero or null.
Then the linklet's start function runs:

1. For each function whose table index the linklet takes (`func-index`),
   append it to the table and keep the index in a global, in the order the
   compiler meets them.
2. Build the linklet's quoted data.
3. The other global initializers and module-level expressions, in
   source order.

Quoted fixnums and `#f` are the constant expressions `(ref.i31 n)` and
`(ref.null eq)`, and `'()` and `#t` read immutable globals the syntax
library defines for them, also a constant expression. The compiler
serializes the linklet's other quoted data into one passive data segment,
which the syntax library turns into a table of objects when the linklet
starts; code reads a quoted datum from the table. So compiled code does
not grow with its literals, and each is built once per instance. As in
Scheme, equal quoted data may share structure: whether two quoted data,
or parts of them, are the same reference is unspecified.

A phase-1 linklet's module-level expressions run each time the linklet is
instantiated, which is once per compilation that needs it.

## 4. Host interface

Imports from the instance `"host"`. Every pointer is into the **caller's
own memory**, the one the calling instance exports as `"memory"`. The host
provides no clocks, randomness or other nondeterminism, so compile-time
execution is reproducible, which the bootstrap fixpoint (stage2 = stage3)
depends on. The files a program reads and its arguments are its input,
like the source a compiler reads.

| Import | Type | Meaning |
|---|---|---|
| `write` | `(fd ptr len) -> i32` | write bytes to fd 1 or 2; returns `len` |
| `trap` | `(ptr len) -> ()` | abort with the UTF-8 message at `ptr` |
| `instantiate` | `(name name-len bytes bytes-len shift) -> i32` | compile and instantiate the wasm module in `bytes`, link its imports by name, and register it as `name`. At a phase shift `shift` > 0, each import from a linklet `<module>@<phase>+<t>` links to `<module>@<phase>+<t + shift>` instead (3.2). 0 on success. |
| `export_index` | `(inst inst-len field field-len) -> i32` | append the function `inst.field` to the caller's table (exported as `"table"`) and return its index, or -1 |
| `error_message` | `(buf cap) -> i32` | copy the last error of `instantiate`, `read_file` or `write_file` into `buf`; returns its length |
| `arg_count` | `() -> i32` | the number of the program's command-line arguments |
| `arg` | `(i buf cap) -> i32` | copy at most `cap` bytes of argument `i` into `buf`; returns its length, or -1 if there is no argument `i` |
| `read_file` | `(path path-len buf cap) -> i32` | copy at most `cap` bytes of the file named by the UTF-8 path into `buf`; returns the file's size, or -1 |
| `write_file` | `(path path-len buf len) -> i32` | write the `len` bytes at `buf` to the file named by the path, creating or replacing it; 0, or -1 |
| `exit` | `(code) -> ()` | end the process with status `code` |

`instantiate` is **the hook**: wasm cannot make new code executable by
itself, and this is how it does. The self-hosted compiler will use it the
way stage0 uses the equivalent C functions. An instantiated module can reach
exactly what its imports name, so compile-time code runs sandboxed.
[v0: the first five are tested from kernel code in `tests/hook.sub`, and
the rest through Substrate (`lib/substrate.sub`).] A path is relative to
the process's working directory.

**Running a program.** `subc build FILE -o DIR` writes the program
`FILE` is the entry of: each linklet it instantiates at run time, as
`DIR/<instance name>.wasm`, and `DIR/program`, their instance names one per
line, each after the linklets it imports from, the entry's own last.
`build/subhost DIR arg ...` runs it without stage0: in one store, it
instantiates each linklet under its name, gives the program the arguments,
and calls the entry's `main`. It exits with status 0 when `main` returns,
1 if the program cannot be loaded, 2 when it traps, with the message on
stderr, or the status the program passes to `exit`. Wasm code cannot catch
a trap, but the store stays usable after one: if the entry exports a
function `on-trap`, the host calls it after a trap in `main`, with the
trap's message as its last error message (`error_message`), and it reports
the trap instead of the host. The compiler's `on-trap` writes the message
where the macro or other compile-time function that trapped was used.
Wasm is the program's
form on disk; the engine compiles it to machine code each time it is
loaded. After bootstrap the compiler is such a program.

`host/subhost.mjs DIR arg ...` is the same host over Node's V8. V8's
JavaScript API does not tell a host import which instance called it, so
this host finds the caller's memory and table through the caller's
exports, and runs a module's start function just after instantiating it
rather than during instantiation, when the exports do not exist yet.
`bin/sub` runs the compiler on V8: today it runs it about five times
faster than wasmtime, whose support for GC is younger (a collector that
counts references and frees objects one at a time, and a call into the
runtime for each allocation and for each cast to anything but the
object's own type). The test suite runs on either host.

## 5. The kernel language

The kernel is WebAssembly written as S-expressions, plus bindings,
quotation and compile-time forms.

### 5.1 Types

- Numbers: `i32`, `i64`, `f32`, `f64`.
- References: `anyref`, `eqref`, `i31ref`, `structref`, `arrayref`,
  `funcref`, `externref`, and `(ref T)` or `(ref null T)` where `T` is one
  of `any eq i31 struct array func extern none nofunc` or a declared type.
  A declared function type is below `func` only: functions are not in the
  `any` hierarchy.
- The words of type syntax (`ref null mut struct array field sub final func
  rec ->`) are compared by name, like wasm's keywords, not looked up as
  bindings. So they are reserved: a declared type may not be named by one,
  nor by a built-in type name (including `i8`, `i16` and the shorthands
  such as `eqref`).
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
  declarations of the same structure are one type wherever they are, in two
  modules or lifted by a macro, and the checker agrees with wasm's
  run-time tests, `ref.test` and `ref.cast`. A type standing alone is a
  group of one. Mutually recursive types are written in one `rec` group,
  whose member order matters, as in wasm, so code that generates recursive
  types, such as a type function, should declare each strongly connected
  set of them as one group, in a canonical order. Code that must tell
  values of the same structure apart stores the difference in the value,
  as `lib/struct.sub` does with a brand per variant and Substrate's records
  with a descriptor.
- **Type functions.** In a type position, a form whose head is a macro is
  expanded until it is not, so a compile-time function can compute a
  type: `(ref (tuple i32 3))`, as in Zig. Such a macro usually declares the
  type with `syntax-local-lift-definition` and returns its name. Uses in
  any module get the same type, since the declarations have the same
  structure; the macro can remember a name to declare the type once per
  module
  (`tests/fixtures/tuple.sub`).
  Type positions are the types of parameters, results, globals, `let`
  bindings, fields and signatures, and the type immediates of GC
  instructions.

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
(require name source item ...)      ; source: "path" or syntax; item: x or [new old]
(require-unqualified name source)   ; every provided name unqualified too (3.1)
(provide item ...)                  ; phase 0 only; item: x or [new old]
(freestanding)                      ; see 3.4
(module-pass f)                     ; phase 0; f: a phase+1 function (6.6)
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
unbound. A
macro that needs the whole module can expand into a core expression form,
such as `let`, whose contents wait for the second pass. Module-level
applications and literals are expressions: their implicit `#%app` and
`#%datum` (5.3, 5.4) are applied in the second pass, when every
definition is known. Racket applies `#%app` in the first pass, which is
harmless there because its `#%app` does not depend on what the function
is; here a language's `#%app` usually does (`identifier-binding-kind`). So an
application cannot expand into a definition; a language provides a named
form, such as `define`, for that.

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
function subtype takes parameters its supertype's fit and returns results
that fit its supertype's, as in wasm. A function is given a declared type
by a `(type T)` clause first in its body, as in wasm's
`(func $f (type $t) ...)`; its parameters and results must be `T`'s. That type is part of the
function's declaration, so other modules import it at `T`, and
`(ref.func f)` is a `(ref T)`. A function without the clause has only its
signature, and `ref.func` does not accept it. An `import` can name a
function type in place of the signature. `(call-ref T f arg ...)` calls
`f`, a `(ref null T)`, and is emitted as `return_call_ref` in tail
position. A closure is the usual case: its struct and its code's function
type refer to each other, so they are one `rec` group.

**Inline functions.** `#:inline` after a function's head makes it an
inline function: a direct call of it, in any module, is compiled as its
body, with the arguments bound to new locals in order and the result at
the function's declared result types; a `return` in the body leaves only
the body. A wasm engine cannot inline a call of another module's function,
because modules are compiled apart and linked when they are instantiated,
so this is how a library's small functions, such as the syntax library's
`car`, are inlined into the code that uses them. A call is compiled so
only if the function's body has been compiled before it: a function's
calls of itself, and calls before its definition in its own module, stay
calls. So that an inlined call does what the call would, the body must
not depend on which module it is compiled in:

- It may not use memory or a table, or `call-indirect`, `func-index`, or
  an instruction that names a data or element segment, since in another
  module they would be that module's. `data-address` and `data-size` are
  constants, so a body may pass them to its own module's functions.
- It may quote only fixnums, booleans, `()`, symbols and keywords: quoted
  data is made by the module that holds the code, and only these are the
  same values whichever module makes them.
- It may call its own module's functions, use its globals and take
  `ref.func` of its functions: every definition is exported (3.3), and a
  module that inlines the body imports what it uses.

A call in an inline function's body to an inline function compiled
before it is inlined there too.

**Function values.** `#:value g` after a function's head, where `g` is a
global, makes `g` the function's value: the function's name used as an
expression, in any module and at any phase, means `g`, while a call of it
stays a call. Without `#:value`, a function's name is not an expression
(use it with `func-index` or `ref.func`). The kernel does not choose how
a function is represented as a value: a language with first-class
functions defines its own, typically a closure made once in a global, so
that every use of the name is the same value, and records it with
`#:value`. Substrate's `define` does so, and its `#%app` calls the
function directly when it gets the arguments the function takes
(`identifier-function-signature`, 2.3).

Globals follow wasm too. A global is immutable unless its type is written
`(mut type)`, and `set!` of an immutable global is an error. An initializer
that is a **constant expression** is compiled into the global itself, as
wasm requires of an immutable global. The constant expressions are
literals, the quoted data `'n` for a fixnum n, `'#f`, `'()` and `'#t`,
`ref.null`, `ref.i31`, `ref.func`, `struct.new`, `array.new`,
`array.new_default` and `array.new_fixed`, `add`, `sub` and `mul` on `i32`
and `i64`, and reads of immutable globals that are imported or defined
earlier in the module, each with constant operands. Any other initializer
runs when the module is instantiated, in source order with the module's
other expressions, so only a mutable global of a numeric or nullable type
may have one. Another module that imports a global imports its mutability
with it.

### 5.3 Expressions

```
literal                             ; see 5.4
id                                  ; local or global variable
(set! id expr)
(let ([id expr] | [id type expr] ...) body ...)    ; parallel scope
(let* ([id expr] | [id type expr] ...) body ...)   ; sequential scope
(lambda ([id type] ...) [-> r] body ...)           ; a function over the locals around it
(begin expr ...)
(if test then [else])
(block label body ...)              ; br to label exits the block
(loop label body ...)               ; br to label restarts the loop
(br label [expr])  (br-if label test)  (return [expr])
(f arg ...)                         ; application: (#%app f arg ...)
(#%app f arg ...)                   ; core: a direct call of the function f
(op arg ... [offset])               ; a numeric or memory instruction, e.g. (i32.add a b)
(call-indirect (t ... -> t ...) index arg ...)
(ref.func f)                        ; (ref T), for f declared with (type T)
(call-ref T f arg ...)              ; call f, a (ref null T)
(func-index f)                      ; i32 index of f in the module's table
(data-address name)  (data-size name)
(select a b test)  (drop expr)  (unreachable)  (nop)
(quote d)  (quasiquote d)           ; syntax-library data (values)
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
  context expects (`i32` if none), and a decimal literal `f64` unless the
  context says `f32`. A mismatch is a compile error before any wasm is
  emitted.
- Non-final expressions in a body are dropped. An `if` without an else,
  and any expression whose value is unused, has no value. The branches of
  an `if` may differ when both are references: its type is the least type
  both fit, such as their common declared supertype, or `eqref`.
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
  The kernel gives `lambda` a meaning but no representation: a language
  lowers each `lambda` to other kernel code, usually a struct holding the
  captured values and a reference to a module-level function, and chooses
  how. The compiler rejects a `lambda` that has not been lowered. A
  language lowers its lambdas in its `#%linklet` (6.5).
- **Application is an implicit form**, as in Racket. A form whose head is
  not bound to a macro, a core form or a wasm operator, including one
  whose head is not an identifier, is expanded as `(#%app head arg ...)`.
  The `#%app` identifier gets the scopes of the form, so it means what
  `#%app` is bound to where the form was written, not where it is
  expanded. A module changes the meaning of its applications by binding
  `#%app` to a macro, usually by importing one, as a module written in
  Substrate does. Code a macro introduces keeps its own module's `#%app`.
  The core `#%app` calls a function directly and rejects anything else. A macro standing for `#%app` must not return an
  application written with the use's scopes, which would expand through it
  again; one written with its own module's scopes uses that module's
  `#%app`. Wasm operators are not applications and never go through
  `#%app`.

### 5.4 Literals

A literal is an implicit form too: `42` is expanded as `(#%datum 42)`,
where `#%datum` gets the scopes of the literal (5.3). Racket writes this
`(#%datum . 42)`; the kernel uses a proper list. The core `#%datum` makes
unquoted literals wasm numbers, as the table below says. A module that
binds `#%datum` to a macro gives its literals another meaning, such as
values, while the literals in other modules' macro templates keep theirs.
The macro must not return a bare literal written with the use's scopes,
which would expand through it again.

Under the core `#%datum`, unquoted literals are wasm numbers. `quote` turns
a literal into a value.
Values are syntax-library data, so a linklet that quotes imports from the
syntax library, as it would for any library function it calls; at phase 0
that is visible in what the program imports, and `(freestanding)` rejects
it (3.4).

| Source | Unquoted | Quoted |
|---|---|---|
| `42` | integer constant, type from context | fixnum or integer value |
| `1.5` | float constant | flonum value |
| `#\a` | `i32` 97 | character value |
| `#t` / `#f` | `i32` 1 / 0 | `#t` value / null |
| `"text"` | error: use `data` for bytes | string value |

The unchanged parts of a `quasisyntax` template keep their lexical context,
which is what macro templates need. The reader abbreviations are
`'` `` ` `` `,` `,@` and `#'` `` #` `` `#,` `#,@`. The reader reads `#%name`
as the symbol `#%name`, and `#:name` as a keyword, as Racket does: a kind
of datum of its own, used for options in forms such as `#:mutable`. A
keyword is not an expression, but quoted it is a value. An integer literal
must fit in 64 bits, from -2^63 to 2^64 - 1, and a number literal is an
integer or a decimal: the reader rejects others, such as `1/2`. A decimal
is the f64 nearest its exact value, ties to even: infinity above the
largest f64, and zero below half the smallest.

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

- **Namespaces.** Types are bound in the type namespace and everything else
  in the value namespace. Positions that take a type (`(ref T)`, the `T`
  of a GC instruction, a supertype) look up types; all others look up
  values. So one name can be both, as a struct library needs for a type
  and its constructor or compile-time value.

- Core bindings have the scope set `{0}`, which every module body carries.
  A module's own definitions have more scopes, so they shadow core names.
- A module-level definition of a name that is already defined with the same
  scope set at the same phase is an error. So is a reference whose best
  candidates have identical scope sets but different meanings.
- **Bindings outlive a module's compilation.** The binding table and scope
  ids last for the whole compiler run. A macro's template identifiers carry
  its module's scopes, so they keep resolving to its module's bindings,
  including ones it does not provide, when another module expands them.
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
  installed at their phase + *s*, with its module scope replaced by a copy
  for that phase shift. So a module required at two phase shifts, which
  has bindings from both at the same phase (a macro `m` shifted up, next to
  the phase-1 function behind `m`), keeps them apart. The syntax literals a
  linklet builds when instantiated at phase shift *t* are shifted the same
  way: every module scope in them, module *X*'s copy for phase shift *s*,
  becomes *X*'s copy for *s* + *t*.
  A literal can hold other modules' scopes as well as its own module's,
  for example when another module's macro wrote part of its code. Only
  module scopes shift; introduction and use-site scopes, and the core
  scope, mean the same at every phase. This is Racket's per-phase module
  scopes, applied eagerly per phase shift.

### 6.2 Hygiene

Each macro use gets a fresh **introduction scope**. The expander flips it
on the syntax it passes to the transformer and again on the syntax that
comes back. Parts of the result that came from the input lose it; parts the
transformer introduced, such as template identifiers, keep it. So a binding
the macro introduces cannot capture the user's identifiers, and the user's
bindings cannot capture the macro's.

A macro use in a **definition context** also gets a fresh **use-site
scope**, added to its input and not removed. In v0 the definition contexts
are module bodies, at any phase. At module level the use site and the
macro's definition share the module's scopes, and the use-site scope keeps
them apart. Without it, a local binding made from the macro's input could
capture a reference the macro introduced. Use-site scopes are removed from
the name of every module-level definition, so a definition a macro makes
from its input is visible to the rest of the module.

This is the same trade Racket makes: a module-level *definition* made from
a macro's input can still capture the macro's own references to that name.
Local bindings cannot.

A transformer can capture on purpose: `(datum->syntax stx 'it stx)` makes an
identifier with the scopes of the use, as if the user had written it.

**Literals drop local scopes.** `quote-syntax` and the constant parts of
`quasisyntax` remove from their literal the scopes of local binding forms
(`func`, `let`, `let*`, `block`, `loop`), keeping module, introduction and
use-site scopes. So every template in a module has that module's scopes
whatever function or `let` it is written in, and a macro can assemble its
output from templates built by different helper functions: an `x` bound
by one refers to the `x` in another. This is Racket's `quote-syntax`
without `#:local`. The kernel has no local macros, so a literal never needs
a local scope.

### 6.3 Compile-time bindings

`(define-syntax s expr)` binds `s` at compile time: `expr` is compiled and
run at phase+1 now, and `s` is bound to its value, an `eqref`, a
**compile-time value**.

- If the value is a transformer (2.1), `s` is a macro. The expander checks
  when `s` is used, since only then is the value known to it.
- Otherwise using `s` as an expression is an error, but macros read the
  value with `syntax-local-value`. This is how extensions share
  information, for example a struct form and a match form.
- `(define-syntax m f)`, where `f` names a phase+1 function of type
  `(eqref) -> eqref`, binds `m` to a transformer that calls `f`. A
  function name is not an expression, so this is a form of its own. `f`
  may come from a module required inside `begin-for-syntax`.

The value lives in a global of the phase+1 linklet, so another module that
requires this one computes it again in its own compile-time store. The
right-hand side is a unit for `#%linklet` (6.5), which may make its value a
transformer: Substrate's makes a procedure one.

[v0] Stage0 expands in Chez, so syntax crosses between Chez and wasm by
copy, through the syntax library's embedder functions (appendix A). The
self-hosted expander will hold references directly and need no copy.

### 6.4 Fully expanded code

Expansion turns a module into **fully expanded code**, as Racket calls it:
syntax in the grammar
below, with every macro use expanded and every application and literal
explicit. `local-expand` returns it, module passes and `#%linklet` (6.5)
receive and return it,
`subc expand` prints it, and the compiler compiles it once no `lambda`
remains (5.3).

```
form ::= (func (id [id type] ...) [#:inline] [#:value id] [-> result] [(type id)] expr ...)
       | (global id type expr) | (global id (mut type) expr)
       | (import id "module" "field" (type ... -> type ...)) | (import id "module" "field" id)
       | (type id def) | (rec (type id def) ...) | (data id offset "bytes" ...)
       | expr

expr ::= id                                   ; a local or global variable, or a function
                                              ; with a value (5.2), which means its value
       | (#%datum literal)                    ; a wasm number, typed by context
       | (quote datum) | (quote-syntax datum)
       | (#%app id expr ...)                  ; a direct call; id names a function
       | (op expr ... [offset])               ; a wasm numeric or memory operator
       | (gc-op immediate ... expr ...)       ; struct.new, ref.cast, ... (5.3)
       | (let ([id expr] | [id type expr] ...) expr ...)
       | (lambda ([id type] ...) [-> result] expr ...)
       | (set! id expr) | (begin expr ...) | (if expr expr [expr])
       | (block id expr ...) | (loop id expr ...)
       | (br id [expr]) | (br-if id expr) | (return [expr])
       | (call-indirect (type ... -> type ...) expr expr ...)
       | (ref.func id) | (call-ref id expr expr ...)
       | (func-index id) | (data-address id) | (data-size id)
       | (select expr expr expr) | (drop expr) | (unreachable) | (nop)
```

- The other module-level forms (`require`, `provide`, `memory`, `table`,
  `freestanding`, `module-pass`, `define-syntax`, `begin-for-syntax`)
  take effect during expansion and leave nothing.
  `let*` becomes nested `let`s. `quasiquote` and `quasisyntax` become
  calls to the syntax library's functions, through identifiers with a
  scope of their own that no module's code has, so user code cannot name
  them.
- Each local variable, at its binder and at each use, records its
  binding, which `local-binding` reads (2.3).
- Types appear where the source wrote them: parameters, results,
  globals, and `let` bindings that give one. Fully expanded code carries no
  inferred types; the kernel's checker infers them after the passes, as
  it does for any code. Type functions (5.1) are expanded: types in fully
  expanded code contain no macro uses.
- **The core forms in fully expanded code are named by identifiers with
  only the core scope**, so they mean the core forms in any module, whatever it
  binds, for example its own `let` or `#%app`. Every other identifier keeps
  its scopes and resolves as before.
- **Fully expanded code can be expanded again**, with the same meaning. Its
  binding forms bind again under fresh scopes, which the references inside
  them get too. So a macro can put `local-expand`'s result into its
  output.
- **Lifted definitions** (`syntax-local-lift-definition`, 2.3) are declared
  as soon as they are lifted, so their names can be used at once, and their
  fully expanded code goes before the module-level form whose expansion
  lifted them.

### 6.5 The linklet hook

A **unit** is code that becomes a linklet or part of one (3.1): a module's
phase-0 code, a `begin-for-syntax`, or the right-hand side of a
`define-syntax`. Once a unit is expanded, and for a module's phase-0 code
once its module passes have run (6.6), the kernel resolves the identifier
`#%linklet` at the unit's phase, with the scopes of where the unit's code
was written: the module's own, the `begin-for-syntax` form's, or the
right-hand side's.

- The core `#%linklet` leaves the unit as it is. A language binds
  `#%linklet` to a transformer (2.1) and provides it; a module that takes
  the language with `require-unqualified` gets it. The kernel calls the
  transformer with `(#%linklet kind form ...)`, where `kind` is the symbol
  `module`, `begin-for-syntax` or `define-syntax`, and the forms are the
  unit's fully expanded code (6.4). A `define-syntax` unit has one form,
  the right-hand side.
- The transformer returns the unit's forms as a list. It may rewrite
  forms and add definitions. For a `define-syntax` unit the last form is
  the expression whose value `define-syntax` binds, and the others are
  definitions it needs.
- What it returns must be fully expanded. It is expanded again only to
  bind the names it introduces: a macro use there is an error, and a
  definition there replaces the unit's own of the same name and scopes. A
  form it returns unchanged, the same object as a form it was given, and
  in the same order among those, introduces nothing, so it is not expanded
  again. The transformer has an introduction scope, as a macro use does
  (6.2).
- `#%linklet` is resolved per phase, so a module's phase-1 code gets the
  hook of the language it takes at phase 1, which may differ from its
  phase-0 language. A module whose phase-1 code is kernel code gets the
  core hook.
- This is where a language lowers `lambda` (5.3) and makes its values
  transformers. Substrate's `#%linklet` converts the closures of every
  unit, and makes the value of a `define-syntax` unit a transformer when
  it is a procedure. A language built on another provides that one's
  `#%linklet`, or its own that runs it.

### 6.6 Module passes

`(module-pass f)` declares that once the module is expanded, the phase+1
function `f`, of type `(eqref) -> eqref`, rewrites the
module's phase-0 fully expanded code. Passes run in the order they are declared.
A library usually provides a macro that expands into the declaration.

- A pass gets the module's forms as one syntax list and returns a list of
  forms, as a syntax list or a plain list. It may add, remove and rewrite
  forms, and write any code, not only fully expanded code.
- What it returns is expanded again, then type-checked and compiled like
  any code, so a pass's mistakes are compile errors. A definition it
  returns with the same name and scopes as one of the module's replaces
  that definition, so a pass can change a function's body or signature.
  A definition it leaves out is removed, and code that still uses it, or
  a `provide` of it, is an error.
  It may return only `func`, `global`, `import`, `type` and `data` forms
  and expressions.
- A pass has an introduction scope, as a macro use does (6.2): flipped on
  its input and its output, so the names it introduces, such as a global
  it adds, cannot capture the module's names or be named by them.
- A module's passes run before its `#%linklet` (6.5), the hook with which a
  language rewrites every unit of the modules that take it.

## 7. Open questions and later milestones

- **Extending a language's hook**: a library that adds a stage to a
  language's `#%linklet`, such as CPS for general effect handlers, provides
  its own `#%linklet` that runs the language's. A module that takes both
  the language and the library with `require-unqualified` then binds
  `#%linklet` twice, which is an error, so the library must provide the
  whole language itself. `provide` lists names one by one; that wants a
  form for everything a module provides except some names. Nothing needs
  it until a library adds a stage.
- **Controlling expansion**: `#%linklet` rewrites a unit after it is
  expanded (6.5). A language cannot change how a module body expands, as
  Racket's `#%module-begin` can. Nothing planned needs that.
- **Inferred types in fully expanded code**: fully expanded code carries
  only the types the source wrote (6.4). A pass that creates wasm
  declarations from the code it rewrites, such as CPS for general effect
  handlers or closure conversion for a typed language, would need the
  checker to write types into fully expanded code before the pass, and
  queries for the types of imported definitions. Substrate's `#%linklet`
  gives a captured variable the type it is written with, or `eqref`, so a
  lambda that captures a kernel local whose inferred type is another fails
  to type-check. Nothing planned before bootstrap needs more.
- **Structs after the typed layer**: declared types are identified by
  structure (5.1), so `lib/struct.sub`'s accessors check brands at run
  time: passing a `fahrenheit` to `celsius-t` is a run-time error, where
  under nominal types it was a compile-time one. With the typed layer, a
  rung after bootstrap, revisit `struct.sub`, `match` and
  `examples/shapes.sub` so that it is a compile-time error again.

## Appendix A: stage0's syntax library representation (not part of the contract)

This describes `compiler/syntax.sub` and `stage0/marshal.sls` as they are.
Macros must not depend on it; the compiler may, because it is part of the
expander.

- **Types**, all in one recursion group, so that no type declared elsewhere
  is the same wasm type unless it copies the whole group (5.2):

  | Type | Definition | Holds |
  |---|---|---|
  | `%string` | `(array (mut i8))` | UTF-8 bytes |
  | `%pair` | `(struct (field car eqref) (field cdr eqref))` | pairs |
  | `%symbol` | `(struct (field name (ref %string)) (field hash i32))` | symbols, with their name's hash |
  | `%atom` | `(struct (field kind i32) (field value i32))` | characters (kind 0), `#t` (1), `()` (2) |
  | `%syntax` | `(struct (field e (mut eqref)) (field scopes eqref) (field srcloc eqref) (field props eqref) (field pending (mut eqref)))` | syntax objects |
  | `%srcloc` | `(struct (field source eqref) (field line i32) (field col i32) (field pos i32) (field span i32))` | source locations |
  | `%table` | `(array (mut eqref))` | the symbol table, the handle table and a linklet's quoted data |
  | `%integer` | `(struct (field negative i32) (field magnitude i64))` | integers beyond the fixnum range |
  | `%flonum` | `(struct (field value f64))` | flonums |
  | `%builder` | `(struct (field bytes (mut (ref %string))) (field length (mut i32)))` | string builders |
  | `%keyword` | `(struct (field name (ref %string)))` | keywords |
  | `%transformer` | `(struct (field code (ref %transformer-code)) (field env eqref))` | transformers |

  `%transformer-code`, `(func (eqref eqref -> eqref))`, is declared
  before the group, alone, so other modules can declare it too.

- **Values**: a fixnum is an `i31ref`. `#f` is null. `#t` and `()` are
  single `%atom` objects made at start. A linklet's quoted data is a
  `%string` made with `array.new_data` from its data segment, which
  `%deserialize` turns into a `%table` of objects (the format is in
  `compiler/syntax.sub`). The compiler declares these types in the linklet;
  wasm makes them the same types as the library's.
- **Syntax objects** are wrapped eagerly: the datum of a list is a list
  whose elements are syntax objects. Scopes are a list of fixnum scope ids,
  newest (greatest) first, so a change to a new scope is made at the
  front; scope 0 is the core scope. The pending scope changes (6.1) are a
  list of `(scope . change)`, change 0 to add, 1 to remove or 2 to flip, at
  most one per scope; `syntax-e` makes them on the syntax objects in `e`,
  stores the result in `e` and empties `pending`. The source of a srcloc is
  a symbol naming the file. Line is 1-based, column and position 0-based.
  Properties are a list of `(key . value)` pairs, newest first, with each
  key at most once. The expander records a local variable's binding in
  the property `%local-binding`.
- **Memory**: the library's memory holds its error messages, and from
  address 1024 the buffer stage0 copies values through.
- **Embedder interface (stage0 only)**: Chez cannot hold GC references, so
  it names objects by `i32` handles, indexes into the library's handle
  table (handle 0 is `#f`). A value crosses whole, in the format of a
  linklet's quoted data, through the buffer: stage0 writes the bytes and
  `%h-deserialize` builds the objects, or `%h-serialize` writes a value
  and stage0 reads the bytes. A value the format has no kind for crosses
  as a handle. Handles made while a macro runs are released when it
  returns. A compile-time value is fetched the first time it is needed,
  perhaps while a macro runs, so its handle is pinned: pinned handles are
  negative, index a second table, and are never released. Each store gets
  a small entry linklet per compile-time value and per module pass it
  uses, which converts between handles and references. Transformers are
  called through `%h-call-transformer`.
  After bootstrap this section goes away.
- **Shifted literals**: `%scope-map-add` tells `%make-syntax` to replace
  one scope id with another. Stage0 records which module and phase shift
  each module scope stands for, and each linklet lists the module scopes in
  its literals. Around the instantiation of a linklet at phase shift *t* ≠ 0
  it maps each of them to its copy for its phase shift + *t* (6.1), and
  clears the map
  after (`%scope-map-clear`).
