# Substrate kernel specification (v0 draft)

Substrate is a thin Lisp over WebAssembly. Its one real addition to wasm is
compile-time execution: macros are ordinary kernel code, compiled to wasm
and run by the same engine that runs programs. The aim is that different
languages can be built as libraries over one small kernel.

Status markers: **[v0]** is implemented by stage0 now, **[planned]** is
specified but not built yet.

## 1. Principles and architecture

### 1.1 Principles

Every rule in this document follows from these four.

1. **The kernel is wasm with names, plus compile-time execution.** Memory,
   heaps, garbage collection and value representations are either plain wasm
   or libraries. The kernel adds no memory model: a module manages its memory
   with wasm instructions.
2. **Phases are uniform.** The language is the same at every phase. Each
   phase gets its own instances of whatever its code uses, so a program and
   the macros that compile it never share state.
3. **Syntax belongs to the expander.** Macros create and inspect syntax only
   by calling the expander's functions (section 2). The list of those
   functions, with what their `i32`s mean, is the contract. How syntax is
   laid out in memory is not part of it.
4. **The compiler is an ordinary program.** After bootstrap it links the
   expander, because it transforms code, and the language it is written in,
   like any other program would.

### 1.2 Components

| Component | What it is | Where |
|---|---|---|
| host | Creates stores, links instances by name, provides the instantiate hook and I/O (section 4). Owns no memory. Permanent: after bootstrap it runs the self-hosted compiler. | `host/subhost.c` (C, over wasmtime) |
| compiler | Reader, expander, kernel compiler, binary encoder. | stage0: `stage0/*.sls` (Chez Scheme) |
| expander module | The wasm half of stage0's expander: syntax in its own memory, and the contract functions of section 2. After bootstrap it becomes part of the self-hosted compiler. | `stage0/expander.sub` (kernel code) |
| libraries | Ordinary kernel code: printing, `define-macro`. Included by source until modules exist. | `lib/*.sub` |
| languages | Later libraries built on the kernel: structs, effects, a dynamic Lisp, ... | not yet |

### 1.3 Who owns what

| | While compiling | While a program runs |
|---|---|---|
| expander module (syntax) | always instantiated in the compile-time store, with its own memory | instantiated only if the program calls an expander function |
| each module's memory and table | its own, if it defines them | its own, if it defines them |
| the host | no memory of its own; reads and writes the caller's | same |

A **store** is one wasm store with one linker. The **compile-time store**
lives for one compiler run and holds the expander module and every module
instantiated to run phase ≥ 1 code. A **run-time store** holds a program's
modules and whatever they import.

## 2. The macro contract

### 2.1 Transformers

A **transformer** is a phase-1 function of type `(i32) -> i32`. The
expander calls it with the syntax object for a macro use (the whole form,
or the identifier alone) and expands the syntax object it returns.
`(define-syntax m f)` makes `m` a macro whose transformer is `f`.

### 2.2 Values

The functions below pass **values**: `i32` words that stand for data.
The contract promises only this about them:

- `#f` is the word 0, so `if` treats a value as true unless it is `#f`.
- Two values are the same datum only if their words are equal. Symbols are
  interned: two symbols with the same name are the same word.
- Everything else about the encoding is private to the expander
  (appendix A).

Counts, indices, bytes and predicate results are wasm numbers, not values:
`(length l)` is an `i32` count and `(pair? v)` is 1 or 0.

### 2.3 Functions

All are imported from the instance `"expander"`. Parameters are values
unless marked `i32`.

| Group | Functions |
|---|---|
| atoms | `(fixnum n:i32)`, `(fixnum-value v) -> i32`, `(fixnum? v) -> i32`, `(char? v) -> i32`, `(char->integer c) -> i32`, `(integer->char n:i32)`, `(boolean? v) -> i32`, `(null? v) -> i32` |
| lists | `(cons a d)`, `(car p)`, `(cdr p)`, `cadr`, `cddr`, `caddr`, `cdddr`, `(pair? v) -> i32`, `(list? v) -> i32`, `(length l) -> i32`, `(append a b)`, `(reverse l)` |
| strings and symbols | `(string? v) -> i32`, `(string-length s) -> i32`, `(string-byte s i:i32) -> i32`, `(string=? a b) -> i32`, `(string-append a b)`, `(symbol? v) -> i32`, `(symbol->string s)`, `(intern s)`, `(symbol-append a b)` |
| syntax | `(syntax? v) -> i32`, `(syntax-e s)`, `(identifier? v) -> i32`, `(syntax->list v)` (a list, or `#f`), `(syntax->datum v)`, `(datum->syntax ctx d)`, `(syntax-rewrap s e)`, `(splice-list v)` |
| queries | `(syntax-local-value id)` (the value bound by `define-static`, or `#f`), `(syntax-error stx msg)` (aborts expansion, blamed on `stx`), `(free-identifier=? a b) -> i32` |

- `syntax-e` of an identifier is a symbol, and of a literal it is the
  literal's value. Of a list it is a list whose elements are syntax.
- `datum->syntax` wraps a value, giving every new syntax object the scopes
  of `ctx` (a syntax object, or `#f` for none).
- `syntax-rewrap` copies syntax object `s` around a new datum `e`, keeping
  its scopes and source location. `quasisyntax` is built on it.
- Accessors trap with a message ("expected a pair") when given the wrong
  kind of value.

[v0] Stage0 implements the queries in Chez and reaches them through host
imports. The rest are functions of `stage0/expander.sub`, whose other
exports (named with a leading `%`) are internal to the compiler.

## 3. Units of compilation and linking

### 3.1 Modules, phases and chunks

- One source file is one module. The code of a module at one phase compiles
  to one wasm module. Phase 0 is the program. Phase *n*+1 code runs while
  phase *n* is expanded.
- Expansion must run phase-1 code before the module is finished: a macro
  works on the line after its definition. So phase ≥ 1 code is compiled and
  instantiated in **chunks**, one per `begin-for-syntax` form and one per
  `define-static` right-hand side, in source order. A chunk may use the
  functions and globals of earlier chunks, not later ones.
- [v0] Only the phase-0 module is written out. Writing out the phase-1
  module, for use by other modules, is **[planned]** with `require`.

### 3.2 Linking

- Every instance in a store is registered with the linker under a unique
  name: `expander`, the program's `main`, and chunks named
  `<module>@<phase>#<n>`. Modules import from each other by those names.
- **A module imports only what its code uses.** Calling an expander
  function, quoting data that lives in the expander's heap (pairs, symbols,
  strings), or using `quote-syntax` or `quasisyntax` imports from
  `"expander"`. Quoted atoms such as `'()`, `'#t` and `'5` are constants
  and import nothing. Nothing is imported by default.
- **A module owns its memory and table.** Code that uses memory
  instructions or data segments needs a `(memory ...)` in its module, and
  code that uses `func-index` or `call-indirect` needs a `(table ...)`.
  Importing a memory or table from another module is **[planned]** with
  modules.
- A module exports its memory as `"memory"` and its table as `"table"`
  (the host relies on this, section 4), and every module-level function and
  global under its name. If two bindings share a name, the compiler appends
  `.<n>` to later ones.

### 3.3 Initialization

Globals whose initializer is a literal get it as their wasm constant
initializer. Then the module's start function runs:

1. For each function whose table index the module takes (`func-index`),
   append it to the module's table and keep the index in a global. Build
   each quoted constant by calling the expander's functions and keep its
   value in a global. These happen in the order the compiler meets them.
2. The remaining global initializers and module-level expressions, in
   source order.

Quoted data is rebuilt at instantiation, so compiled modules contain no
addresses in the expander's memory.

## 4. Host interface

Imports from the instance `"host"`. Every pointer is into the **caller's
own memory**, the one the calling instance exports as `"memory"`. The host
provides no clocks, randomness or other nondeterminism, so compile-time
execution is reproducible, which the bootstrap fixpoint (stage2 = stage3)
depends on.

| Import | Type | Meaning |
|---|---|---|
| `write` | `(fd ptr len) -> i32` | write bytes to fd 1 or 2; returns `len` |
| `trap` | `(ptr len) -> ()` | abort with the UTF-8 message at `ptr` |
| `instantiate` | `(name name-len bytes bytes-len) -> i32` | compile and instantiate the wasm module in `bytes`, link its imports by name, and register it as `name`. 0 on success. |
| `export_index` | `(inst inst-len field field-len) -> i32` | append the function `inst.field` to the caller's table (exported as `"table"`) and return its index, or -1 |
| `error_message` | `(buf cap) -> i32` | copy the last `instantiate` error into `buf`; returns its length |

`instantiate` is **the hook**: wasm cannot make new code executable by
itself, and this is how it does. The self-hosted compiler will use it the
way stage0 uses the equivalent C function. An instantiated module can reach
exactly what its imports name, so compile-time code runs sandboxed.
[v0: all five, tested from kernel code in `tests/hook.sub`.]

## 5. The kernel language

The kernel is WebAssembly written as S-expressions, plus bindings,
quotation and compile-time forms.

### 5.1 Types

`i32`, `i64`, `f32`, `f64`. A function result is written `-> t` or
`-> (t ...)`, or omitted when there is none. Function types in imports and
`call-indirect` are written `(t ... -> t ...)`.

### 5.2 Module-level forms

```
(func (name [param type] ...) [-> result] body ...)
(global name type init)
(import name "module" "field" (type ... -> type ...))
(memory pages)
(table size)
(data name offset "bytes" ...)      ; active segment at offset in memory
(define-syntax name transformer)    ; transformer: a phase+1 function (2.1)
(define-static name expr)           ; expr is phase+1 code, run now
(begin-for-syntax form ...)         ; forms at phase+1
(begin form ...)                    ; spliced
(include "path")                    ; temporary, until modules exist
expr                                ; runs at instantiation
```

A module body is expanded in two passes, as in Racket. The first pass
expands macro uses at the head of each form, registers definitions, runs
`define-static` and `begin-for-syntax` at once, and splices `begin` and
`include`. The second pass expands function bodies and expressions. So
functions may be mutually recursive, and a macro must be defined before it
is used. A transformer must come from an earlier `begin-for-syntax`.

### 5.3 Expressions

```
literal                             ; see 5.4
id                                  ; local or global variable
(set! id expr)
(let ([id expr] | [id type expr] ...) body ...)    ; parallel scope
(let* ([id expr] | [id type expr] ...) body ...)   ; sequential scope
(begin expr ...)
(if test then [else])
(block label body ...)              ; br to label exits the block
(loop label body ...)               ; br to label restarts the loop
(br label [expr])  (br-if label test)  (return [expr])
(f arg ...)                         ; direct call
(op arg ... [offset])               ; a wasm instruction, e.g. (i32.add a b)
(call-indirect (t ... -> t ...) index arg ...)
(func-index f)                      ; i32 index of f in the module's table
(data-address name)  (data-size name)
(select a b test)  (drop expr)  (unreachable)  (nop)
(quote d)  (quasiquote d)           ; expander data (values)
(quote-syntax d)  (quasisyntax d)   ; syntax objects
```

- Types are checked bidirectionally. An integer literal takes the type its
  context expects (`i32` if none), and a decimal literal `f64` unless the
  context says `f32`. A mismatch is a compile error before any wasm is
  emitted.
- Non-final expressions in a body are dropped. An `if` without an else,
  and any expression whose value is unused, has no value.
- A call in tail position whose callee's result types match the function's
  is emitted as `return_call`, so recursion in tail position runs in
  constant stack.
- Primitive operators are every wasm numeric, conversion and memory
  instruction under its WAT name. Loads and stores take an optional trailing
  literal offset: `(i32.load p 8)`, `(i32.store p v 8)`.
- Labels are bindings and obey scope like variables.

### 5.4 Literals

Unquoted literals are wasm numbers. `quote` turns a literal into a value.

| Source | Unquoted | Quoted |
|---|---|---|
| `42` | integer constant, type from context | fixnum value |
| `1.5` | float constant | not supported in v0 |
| `#\a` | `i32` 97 | character value |
| `#t` / `#f` | `i32` 1 / 0 | `#t` / `#f` values |
| `"text"` | error: use `data` for bytes | string value |

`quote`, `quasiquote`, `quote-syntax` and `quasisyntax` build expander data,
so code that uses them links the expander (3.2), at whatever phase it runs.
The unchanged parts of a `quasisyntax` template keep their lexical context,
which is what macro templates need. The reader abbreviations are
`'` `` ` `` `,` `,@` and `#'` `` #` `` `#,` `#,@`. Integers outside the
fixnum range cannot be quoted.

### 5.5 Base bindings

Every module sees, at every phase: the kernel forms, the wasm operators,
and the contract functions of section 2.3.

## 6. Expansion

### 6.1 Binding

Binding follows Flatt's sets of scopes. Every binding form (`func`, `let`,
`let*`, `block`, `loop`) creates a fresh scope and adds it to the syntax it
governs. A binding is recorded as (symbol, scope set, phase) and maps to a
key. An identifier refers to the binding whose scope set is the largest
subset of its own. If there is no unique largest subset, the reference is an
error.

- Core bindings have the scope set `{0}`, which every module body carries.
  A module's own definitions have more scopes, so they shadow core names.
- [v0] Bindings are recorded per phase. Scope sets are not yet per phase.
- **[planned, next]** Hygiene: a fresh macro-introduction scope flipped on
  the input and output of every transformer call, and use-site scopes in
  definition contexts.

### 6.2 Compile-time bindings

- `(define-syntax m f)`: `m` is a macro whose transformer is the phase+1
  function `f`.
- `(define-static s expr)`: `expr` is compiled and run at phase+1 now, and
  `s` is bound to its value. Using `s` as an expression is an error, but
  macros read the value with `syntax-local-value`. This is how extensions
  share information, for example a struct form and a match form.

[v0] Syntax crosses between Chez and wasm by copy: stage0 writes the use's
syntax into the expander module's memory and reads the result back. The
self-hosted expander will not need the copy.

## 7. Open questions and later milestones

- **Hygiene** (next): introduction and use-site scopes (6.1).
- **Modules and phases**: `require`/`provide`, `for-syntax` imports,
  writing out phase-1 modules, per-phase scope sets as in Racket, scope ids
  that survive separate compilation, and importing a memory or table from
  another module (so a language's runtime can supply them). Modules replace
  `include`.
- **Extension points**: `#%app`, `#%module-begin`, `local-expand`, syntax
  properties (the `props` field is always empty in v0), lifting
  definitions out of expressions.
- **Expander data at run time**: the expander module's heap is one arena
  that is never freed. That suits a compilation. Programs that keep calling
  the expander (a REPL, a long-lived compiler) will need memory management
  for it.
- **Baking compile-time data into output**: a language can emit data it
  computed at compile time as `data` segments. The kernel provides `data`;
  the layout of what is baked in is the language's business.
- **More kinds of data**: bignums, floats and vectors as values are not in
  v0.

## Appendix A: stage0's expander data layout (not part of the contract)

This describes `stage0/expander.sub` and `stage0/marshal.sls` as they are.
Macros must not depend on it; the compiler may, because it is part of the
expander.

- **Memory**: the expander module's own. Bytes 1024..1215 hold its error
  messages, and its heap starts at 4096. The heap is a bump allocator, one
  arena per store, never freed.
- **Value words**: fixnum `(n << 1) | 1`, `#f` 0, `#t` 10, `()` 18,
  character `(code point << 3) | 4`. Any other word with its low three bits
  clear is the address of a heap object (8-aligned).
- **Heap objects**: a 32-bit header (bits 0..6 a type code, bits 8..31 a
  field or byte count), then 4-byte fields.

  | Code | Object | Contents |
  |---|---|---|
  | 1 | pair | car, cdr |
  | 2 | symbol | name (string) |
  | 3 | string | UTF-8 bytes |
  | 4 | syntax | datum, scopes, srcloc, props |
  | 5 | srcloc | source, line, column, position, span |
  | 6 | intern table | 1024 buckets, each a list of symbols |

- **Syntax objects** are wrapped eagerly: the datum of a list is a list
  whose elements are syntax objects. Scopes are a list of fixnum scope ids
  in ascending order; scope 0 is the core scope. The source of a srcloc is
  a symbol naming the file. Line is 1-based, column and position 0-based.
