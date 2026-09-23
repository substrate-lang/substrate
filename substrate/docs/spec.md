# Substrate kernel specification (v0 draft)

Substrate is a thin Lisp over WebAssembly whose only real addition to wasm
is compile-time execution: macros and other compile-time code are kernel
code, compiled to wasm and run on the same abstract machine as the program.

This document fixes the four things that the stage0 compiler (Chez Scheme)
and the future self-hosted compiler (wasm) must agree on. Everything else
may change freely; a change here is a two-step migration once the compiler
is self-hosted.

1. The **value and memory layout** (section 2).
2. The **unit of compilation** and how compiled units link (section 3).
3. The **host interface**, including the instantiate hook (section 4).
4. The **macro API**: how transformers are called and how they talk to the
   expander (section 6).

Section 5 describes the kernel language itself. Section 7 lists what is
deliberately left open.

Status markers: **[v0]** is implemented by stage0 at this milestone,
**[planned]** is specified but not yet implemented.

---

## 1. Architecture

```
            source (.sub)
                 |
        reader -> syntax objects
                 |
        expander -----------------------+   phase >= 1 code is compiled
          |  (sets of scopes, phases)   |   to wasm "chunks" and run
          |                             v   in the compile-time store
          |                      +--------------+
          |                      | compile-time |  rt + chunks, via the
          |                      |    store     |  instantiate hook
          |                      +--------------+
          v
    fully expanded kernel forms
                 |
        compiler (types, lowering, binary encoder)
                 |
        phase-0 wasm module  --->  run-time store: rt + program
```

- A **store** is one wasm store with one linker, one shared linear memory
  and one shared funcref table. Both live in the `rt` instance.
- The **compile-time store** lives for one compiler run. It holds `rt` and
  every module instantiated to run phase >= 1 code.
- The **run-time store** holds `rt` and the program's phase-0 modules.
  Compile-time state never reaches it except through emitted code.
- The **host** (`host/subhost.c`, over the wasmtime C API) owns stores and
  provides the imports in section 4. It is permanent: after bootstrap it
  runs the self-hosted compiler.
- **rt** (`rt/rt.sub`) is written in the kernel language. It owns memory,
  the table, the allocator and the data operations every module shares.

## 2. Values and memory layout

### 2.1 Memory

- wasm32 linear memory, exported by `rt` as `mem`. Every other module
  imports it as `rt.mem`.
- Addresses `0 .. 4095` are reserved. Address 0 is never a valid object,
  which is what makes `#f = 0` below safe. `1024 .. 4095` is scratch space
  for `rt` (number formatting) and the host.
- The heap starts at 4096 (`HEAP_BASE`) and grows upward with a bump
  pointer (`rt` global `hp`). Objects are 8-byte aligned.
- v0 never frees. A compiler run is one arena. Collection is a later rung
  (section 7), and the layout below is chosen so that it stays possible.

### 2.2 Value words

A **value** is one `i32` word. Its low bits say what it is:

| low bits | meaning                      | encoding                          |
|----------|------------------------------|-----------------------------------|
| `...1`   | fixnum (31-bit signed)       | `(n << 1) \| 1`                    |
| `...000` | heap pointer, or `#f` if 0   | the object's address              |
| `...010` | immediate constant           | `(id << 3) \| 2`                   |
| `...100` | character                    | `(codepoint << 3) \| 4`            |
| `...110` | reserved                     |                                   |

Immediate constants:

| id | value      | word |
|----|------------|------|
| 1  | `#t`       | 10   |
| 2  | `()`       | 18   |
| 3  | void       | 26   |
| 4  | eof        | 34   |
| 5  | unbound    | 42   |

`#f` is the word 0. So a value is "true" in the Lisp sense exactly when it
is nonzero, which is wasm's own truth test: kernel `if` on a value needs no
conversion. Pointers are raw aligned addresses, so field access is a plain
`i32.load` with a constant offset.

### 2.3 Heap objects

Every heap object starts with a 32-bit header:

```
bits 0..6   type code
bit  7      reserved for the collector (0 in v0)
bits 8..31  length: field count for word objects, byte count for byte objects
```

The object occupies `align8(4 + 4*fields)` or `align8(4 + bytes)` bytes.
Fields start at offset 4 and are 4 bytes each.

Every field of a **word object** is a value (section 2.2). Byte objects hold
no values. A collector can therefore trace any object from its header alone.

| code | name      | kind  | fields                                            |
|------|-----------|-------|---------------------------------------------------|
| 0x01 | pair      | word  | car, cdr                                          |
| 0x02 | symbol    | word  | name (string), hash (fixnum)                      |
| 0x03 | string    | bytes | UTF-8 bytes                                       |
| 0x04 | vector    | word  | elements                                          |
| 0x05 | bytevector| bytes | bytes                                             |
| 0x06 | syntax    | word  | e, scopes, srcloc, props (section 2.4)            |
| 0x07 | procedure | word  | table index (fixnum), environment (value, `#f` in v0) |
| 0x08 | box       | word  | value                                             |
| 0x09 | srcloc    | word  | source, line, column, position, span              |
| 0x0A | record    | word  | descriptor, fields... **[planned]**               |
| 0x0B | flonum    | bytes | 4 bytes of padding, then an f64 **[planned]**     |

Codes `0x01..0x3F` belong to the kernel. `0x40..0x7F` are free for libraries
(for example the structs rung). Code `0x00` is never valid, so a read of
zeroed memory shows up as a type error.

**Symbols** are interned per store by `rt.intern`. Two symbols are the same
symbol iff their words are equal. The intern table is private to `rt`.

**Procedures** are how a value names code. Field 1 is an index into the
shared table, so calling a procedure is `call_indirect`. In v0 the
environment is always `#f` (no closures). Closure conversion is a later demo.

### 2.4 Syntax objects

A syntax object (type 0x06) has four fields:

- **e**: the datum. For an identifier it is a symbol. For an atom it is the
  atom. For a list it is a chain of ordinary pairs whose elements are
  syntax objects, ending in `()` or, for an improper list, in a syntax
  object. For a vector it is a vector of syntax objects. Wrapping is eager:
  every node of a list read from source is itself a syntax object.
- **scopes**: the scope set, a proper list of fixnum scope ids in strictly
  ascending order.
- **srcloc**: a srcloc object or `#f`.
- **props**: an association list `((key . value) ...)` with symbol keys, or
  `()`.

A **srcloc** (type 0x09) has: source (symbol, the file), line (fixnum,
1-based), column (fixnum, 0-based), position (fixnum, 0-based character
offset), span (fixnum, characters).

Scope ids are allocated by the expander from a counter that starts fresh for
each compilation, so they are deterministic. Scope 0 is the **core scope**:
it carries the bindings of kernel forms, primitive operators and `rt`
functions.

## 3. Units of compilation

### 3.1 Modules and phases

One source file is one module. A module has code at several **phases**:
phase 0 is run time, phase 1 is the code that runs while phase 0 is being
expanded, and so on.

The compiled form of one (module, phase) pair is one wasm module. v0 emits
only the phase-0 module to disk. Phase 1 exists only inside the
compile-time store while the module is compiled, in the form of chunks
(3.2). Emitting the whole phase-1 module for separate compilation is
**[planned]** and comes with `require`.

### 3.2 Chunks

Expansion has to run phase-1 code before the module is finished: a macro
must work on the line after its `define-syntax`. So phase-1 code is compiled
and instantiated in **chunks**, one per `begin-for-syntax` form and one per
`define-syntax` right-hand side, in source order. A chunk may call functions
and read globals of earlier chunks. It cannot refer to later ones.

### 3.3 Instance names and linking

Every instance in a store is registered with the linker under a unique
name, and modules link by importing from those names:

| import module | provides                                                  |
|---------------|-----------------------------------------------------------|
| `rt`          | `mem` (memory), `tbl` (funcref table), all `rt` functions |
| `host`        | host functions (section 4)                                |
| `expander`    | the macro API (section 6), phase >= 1 modules only        |
| `<instance>`  | functions and globals of an earlier instance              |

Chunks are named `<module>@<phase>#<n>`. The phase-0 program is `main`.

Every module-level function and global is exported under its name. If two
bindings share a symbol (possible once hygiene introduces bindings), the
compiler appends `.<n>` to make the name unique, deterministically.

### 3.4 Initialization

Globals whose initializer is a literal get it as their wasm constant
initializer, so they are set before any code runs. Then the module's start
function runs:

1. **Setup**, in the order the compiler meets them in the code:
   - For each function whose table index the module takes (`func-index`),
     append it to `rt.tbl` with `table.grow` and keep the index in a global.
   - Build each quoted constant (`quote`, `quote-syntax`) in the heap and
     keep its word in a global. String bytes come from a passive data
     segment by `memory.init`. Symbols go through `rt.intern`.
2. The remaining global initializers and module-level expressions, in
   source order.

Because quoted data is rebuilt at instantiation, compiled modules contain
no heap addresses and can be instantiated in any store. A memory-snapshot
primitive that bakes a compile-time heap into the output is **[planned]**.

## 4. Host interface

These are the imports under `host`. The host must not provide clocks,
randomness or any other source of nondeterminism. That keeps compile-time
execution reproducible, which the bootstrap fixpoint (stage2 = stage3)
depends on.

| import                | type                              | meaning |
|-----------------------|-----------------------------------|---------|
| `write`               | `(fd ptr len) -> i32`             | write bytes to fd 1 or 2; returns `len` |
| `trap`                | `(ptr len) -> ()`                 | abort with the UTF-8 message at `ptr` |
| `instantiate`         | `(name name-len bytes bytes-len) -> i32` | compile and instantiate wasm bytes from memory, link its imports by name, and register the instance under `name`. Returns 0, or nonzero on failure |
| `export_index`        | `(inst inst-len field field-len) -> i32` | append the exported function `inst.field` to `rt.tbl` and return its index, or -1 |
| `error_message`       | `(buf cap) -> i32`                | copy the last `instantiate` error into `buf` and return its length |

`instantiate` is **the hook**: wasm cannot make new code executable by
itself, and this is the only way it gets to. The self-hosted compiler will
use it the way stage0 uses the equivalent C function directly. The code an
instantiated module can reach is exactly what its imports name, so
compile-time code runs sandboxed. [v0: all five implemented and tested from
kernel code.]

## 5. The kernel language

The kernel is roughly WebAssembly written as S-expressions, plus bindings,
quotation and compile-time forms. It has no closures, no first-class
functions, no garbage collection and no dynamic types. All of those are
meant to be libraries.

### 5.1 Types

`i32`, `i64`, `f32`, `f64`. A value (section 2.2) is an `i32`. A function
result is written `-> t` or `-> (t ...)` (multiple values), or omitted when
the function returns nothing.

Function types in imports and `call-indirect` are written
`(t ... -> t ...)`.

### 5.2 Module-level forms

```
(func (name [param type] ...) [-> result] body ...)
(global name type init)
(import name "module" "field" (type ... -> type ...))
(memory name min-pages)            ; rt only
(table name min-size)              ; rt only
(define-syntax name expr)          ; expr is phase+1 code
(begin-for-syntax form ...)        ; forms at phase+1
(begin form ...)                   ; spliced
expr                               ; runs at instantiation
```

A module body is expanded in two passes, as in Racket. The first pass
expands macro uses at the head of each form. It registers definitions,
evaluates `define-syntax` and `begin-for-syntax` at once, and splices
`begin`. The second pass expands function bodies and expressions. So
functions may be mutually recursive, and a macro must be defined before it
is used.

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
(f arg ...)                         ; direct call to a function
(op arg ... [offset])               ; a wasm instruction, e.g. (i32.add a b)
(call-indirect (t ... -> t ...) index arg ...)
(func-index f)                      ; i32 table index of function f
(select a b test)  (drop expr)  (unreachable)  (nop)
(quote d)  (quasiquote d)           ; data values
(quote-syntax d)  (quasisyntax d)   ; syntax values
```

- Types are checked bidirectionally. An integer literal takes the type
  its context expects (`i32` if none), and a decimal literal takes `f64` or
  `f32`. Every other expression synthesizes its type, and a mismatch is a
  compile error before any wasm is emitted.
- Non-final expressions in a body are dropped automatically. An `if`
  without an else, and any expression whose value is not used, has no
  value.
- A direct or indirect call in tail position, whose callee's result types
  match the function's, is emitted as `return_call`. Loops written as
  recursion therefore run in constant stack.
- Primitive operators are every wasm numeric, conversion and memory
  instruction under its WAT name (`i32.add`, `f64.convert_i32_s`,
  `i64.load32_u`, `memory.grow`, ...). Loads and stores take an optional
  trailing literal offset: `(i32.load p 8)`, `(i32.store p v 8)`.
- Labels are bindings and obey scope like variables.

### 5.4 Literals

| source          | expression value                          |
|-----------------|-------------------------------------------|
| `42`, `#x2a`    | integer constant, type from context       |
| `1.5`           | float constant, `f64` unless context says `f32` |
| `#\a`           | `i32` code point                          |
| `#t` / `#f`     | the value words 10 / 0                    |
| `"text"`        | a string value (same as `(quote "text")`) |

`(quote d)` gives the value word of `d`. Fixnums, characters, booleans and
`()` are constants, and everything else is built at instantiation (3.4).
Integers outside the fixnum range are a compile error.

`quasiquote` builds data with `unquote` and `unquote-splicing`.
`quasisyntax` builds syntax with `unsyntax` and `unsyntax-splicing`. The
unchanged parts of a `quasisyntax` template keep their lexical context,
which is what macro templates need. The reader abbreviations are
`'` `` ` `` `,` `,@` and `#'` `` #` `` `#,` `#,@`.

### 5.5 Base bindings

Every module sees, through the core scope: the kernel forms above, the
primitive operators, and every function exported by `rt` (`cons`, `car`,
`intern`, `make-procedure`, `make-syntax`, `syntax-e`, `datum->syntax`,
`write`, ...). `rt/rt.sub` is the reference for the `rt` functions and
their behavior. Functions with Scheme names take and return values (a
count is a fixnum), and lower-level helpers such as `alloc` and
`fixnum-value` work on raw `i32`s.

## 6. Expansion and the macro API

### 6.1 Binding

Binding follows Flatt's sets of scopes. Every binding form creates a fresh
scope and adds it to the syntax it governs. A binding is recorded as
(symbol, scope set, phase) and maps to a **binding key**. An identifier
refers to the binding whose scope set is the largest subset of the
identifier's own scopes. If there is no unique largest subset, the
reference is an error.

- Core bindings have the scope set `{0}`, which every module body carries.
  A module's own definitions have more scopes, so they shadow core names.
- v0 records bindings per phase. The scope sets themselves are not
  per-phase yet (section 7).
- **[planned, next milestone]** Hygiene proper: a fresh macro-introduction
  scope is flipped on the input and output of every transformer call, and
  use-site scopes are added in definition contexts.

### 6.2 Transformers and compile-time values

`(define-syntax id expr)` expands and compiles `expr` at phase+1 in its own
chunk, calls it once, and binds `id` to the resulting **compile-time
value**. That value is an ordinary value word in the compile-time store.

- If the value is a procedure, `id` is a macro. When `id` heads a form
  (`(id ...)`) or appears alone, the expander calls the procedure's table
  entry with the form's syntax object and expands whatever syntax object
  comes back. A transformer's wasm type is `(i32) -> i32`. It is usually
  a phase-1 function wrapped as a procedure:
  `(define-syntax m (make-procedure (func-index m-transformer)))`.
- Any other value is **static information**, such as a struct's field
  list. Using `id` as an expression is an error, but macros can read the
  value with `syntax-local-value`. This is how extensions talk to each
  other (a `struct` form and a `match` form, for example).

In v0 syntax crosses the boundary by copy. The expander writes the input
syntax object into the compile-time heap and reads the result back. The
self-hosted expander will keep syntax in the heap and skip the copy.

### 6.3 Expander API

Imports under `expander`, available to code at phase >= 1:

| import                 | type            | meaning |
|------------------------|-----------------|---------|
| `syntax-local-value`   | `(id) -> value` | the compile-time value bound to `id` at the phase being expanded, or `#f` |
| `syntax-error`         | `(stx msg) -> i32` | abort expansion with string `msg`, blamed on `stx`'s srcloc; never returns |
| `free-identifier=?`    | `(a b) -> value` | `#t` iff `a` and `b` refer to the same binding |
| `local-expand`         | **[planned]**   | expand a form partially, stopping at given identifiers |
| `syntax-local-introduce`, `generate-temporary`, `lift` | **[planned]** | |

Stage0 implements these as host functions that call back into the Chez
expander. The self-hosted expander will export them from its own wasm
module under the same names, and the host will play no part.

## 7. Open questions and later milestones

- **Hygiene** (next): introduction and use-site scopes (6.1).
- **Modules and phases**: `require`/`provide`, `for-syntax` imports,
  emitting the phase-1 module, and per-phase scope sets as in Racket. It
  also needs a way to persist scope ids in compiled modules, relative to
  the module rather than to one compilation.
- **Extension points**: `#%app`, `#%module-begin`, `local-expand`,
  syntax properties in the API, and a hook for passes over fully expanded
  modules.
- **Memory snapshot**: bake compile-time heap data into the output as a
  data segment instead of rebuilding it (3.4).
- **GC**: header bit 7 and the all-fields-are-values rule (2.3) are
  reserved for it. The collector needs a shadow stack for roots held in
  wasm locals. The v0 marshaller would also need to root what it builds.
- **Bignums and flonums as values**: not in v0.
