# Substrate kernel specification (v0 draft)

Substrate is a thin Lisp over WebAssembly. Its one real addition to wasm is
compile-time execution: macros are ordinary kernel code, compiled to wasm
and run by the same engine that runs programs. The aim is that different
languages can be built as libraries over one small kernel, and that the
code they produce carries no runtime it did not ask for.

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
| host | Creates stores, links instances by name, provides the instantiate hook and I/O (section 4). Owns no memory. Permanent: after bootstrap it runs the self-hosted compiler. | `host/subhost.c` (C, over wasmtime) |
| compiler | Reader, expander, kernel compiler, binary encoder. | stage0: `stage0/*.sls` (Chez Scheme) |
| syntax library | Syntax objects and the data inside them, as wasm GC objects, and the functions of section 2. After bootstrap it is part of the self-hosted compiler. | `compiler/syntax.sub` (kernel code) |
| libraries | Ordinary modules: printing, `define-macro`. | `lib/*.sub` |
| languages | Later libraries built on the kernel: structs, effects, a dynamic Lisp, ... | not yet |

### 1.3 What runs where

| | While compiling | While a program runs |
|---|---|---|
| the syntax library | always instantiated in each compile-time store; macros link to it | instantiated only if the program's parts import it |
| GC | syntax data lives in the engine's GC heap | only if the program's code uses GC types or the syntax library |
| each module's memory and table | its own, if it defines them | its own, if it defines them |
| the host | no memory of its own; reads and writes the caller's | same |

A **store** is one wasm store with one linker. Each module is compiled
with its own **compile-time store**, which holds the syntax library, the
module's chunks and the parts of what it requires (3.2). A **run-time
store** holds the parts a program loads.

The compile-time environment is garbage collected: syntax objects are GC
objects. A compiled program is garbage collected only if its own code uses
GC types or requires the syntax library.

## 2. The macro contract

### 2.1 Transformers

A **transformer** is a phase-1 function of type `(eqref) -> eqref`. The
expander calls it with the syntax object for a macro use (the whole form,
or the identifier alone) and expands the syntax object it returns.
`(define-syntax m f)` makes `m` a macro whose transformer is `f`.

### 2.2 Values

The syntax library represents data as **values** of wasm type `eqref`.
The contract promises this about them:

- `#f` is the null reference, so `(ref.is_null v)` tests for it.
- `ref.eq` is identity. Symbols are interned, so two symbols with the same
  name are `ref.eq`. Small integers (fixnums) are `ref.eq` when they are
  equal. Characters and strings are not guaranteed to be `ref.eq`; compare
  them with `char->integer` and `string=?`.
- Everything else about the representation is private (appendix A).

Counts, indices, bytes and predicate results are `i32`, not values:
`(length l)` is an `i32` count and `(pair? v)` is 1 or 0. Because values
are references, wasm's own type checking keeps them apart from numbers.

### 2.3 Functions

`(require name syntax)` binds these as `name:function` at the phase where
it appears, plus any it lists to bind unqualified (3.1). They are imported
from the instance `"syntax"`. Parameters are `eqref` unless marked
`i32`.

| Group | Functions |
|---|---|
| atoms | `(fixnum n:i32)`, `(fixnum-value v) -> i32`, `(fixnum? v) -> i32`, `(char? v) -> i32`, `(char->integer c) -> i32`, `(integer->char n:i32)`, `(boolean? v) -> i32`, `(null? v) -> i32` |
| lists | `(cons a d)`, `(car p)`, `(cdr p)`, `cadr`, `cddr`, `caddr`, `cdddr`, `(pair? v) -> i32`, `(list? v) -> i32`, `(length l) -> i32`, `(append a b)`, `(reverse l)` |
| strings and symbols | `(string? v) -> i32`, `(string-length s) -> i32`, `(string-byte s i:i32) -> i32`, `(string=? a b) -> i32`, `(string-append a b)`, `(symbol? v) -> i32`, `(symbol->string s)`, `(intern s)`, `(symbol-append a b)` |
| syntax | `(syntax? v) -> i32`, `(syntax-e s)`, `(identifier? v) -> i32`, `(syntax->list v)` (a list, or `#f`), `(syntax->datum v)`, `(datum->syntax ctx d)`, `(syntax-rewrap s e)`, `(splice-list v)` |
| queries | `(syntax-local-value id)` (the value bound by `define-static`, or `#f`), `(syntax-error stx msg)` (aborts expansion, blamed on `stx`; returns nothing), `(free-identifier=? a b) -> i32` |

- `syntax-e` of an identifier is a symbol, and of a literal it is the
  literal's value. Of a list it is a list whose elements are syntax.
- `datum->syntax` wraps a value, giving every new syntax object the scopes
  of `ctx` (a syntax object, or `#f` for none).
- `syntax-rewrap` copies syntax object `s` around a new datum `e`, keeping
  its scopes and source location. `quasisyntax` is built on it.
- Accessors trap with a message ("expected a pair") when given the wrong
  kind of value.

The queries only work while an expander is running. [v0] Stage0 answers
them in Chez; in a run-time store they trap.

## 3. Modules, parts and linking

### 3.1 Modules and parts

- One source file is one module. A module's code at one phase compiles to
  one wasm module, called a **part**. Phase 0 is the program. Phase *n*+1
  code runs while phase *n* is expanded, so a module's phase-1 part holds
  its transformers, its `define-static` values and its `begin-for-syntax`
  code.
- `(provide id ...)` names the phase-0 bindings other modules get:
  functions, globals, macros, static values, types and data.
- `(require name source item ...)` imports what another module provides.
  `source` is `"path"` (relative to the requiring file) or `syntax` (the
  syntax library, section 2).
  - Everything the source provides is bound **qualified**, as
    `name:thing`. Nothing is imported unqualified by default.
  - Each item also binds one thing unqualified: `x` binds `x`, and
    `[new old]` binds `new` to the source's `old`, in `let` order.
  - A require at phase *p* imports at phase *p*. To import for compile-time
    code, put the require inside `begin-for-syntax`. The required module's
    phase *q* is then phase *p* + *q* in the requiring module.
  - Requiring the same module again is harmless; a name that already names
    another module at that phase, and cycles, are errors.
  - Qualified names are ordinary identifiers: `print:write-int` is one
    symbol. Every kind of binding shares one namespace per phase, and
    binding a name twice at the same phase, by definition or import, is an
    error.
- Expansion must run phase-1 code before the module is finished: a macro
  works on the line after its definition. So while a module is expanded,
  its phase ≥ 1 code is also compiled and instantiated in **chunks**, one
  per `begin-for-syntax` or `define-static`, in source order. When the
  module is done, each phase's code is compiled again as a whole, into the
  part. Other modules only ever use the parts.

### 3.2 Stores and instance names

- Each module is compiled with a fresh compile-time store. The module's
  own chunks, and the parts of the modules it requires, are instantiated
  there on demand. So no compile-time state is shared between the
  compilations of two modules, as in Racket.
- A part instantiated at shift *t* is registered as `<module>@<phase>+<t>`.
  A compiled part imports from other parts by names relative to its own
  module at shift 0. The host adds the shift when it instantiates the part
  (section 4), so one compiled part serves at any phase.
- A program runs in a fresh run-time store holding exactly the parts
  reached from its phase-0 part at shift 0. A module required only inside
  `begin-for-syntax` is never loaded at run time.
- The other instance names are `syntax`, `host`, `expander`, chunks
  (`<module>@<phase>#<n>`) and per-store entry chunks (`entry#<n>`).

### 3.3 Linking

- **A module imports only what its code uses.** Nothing is bound or
  imported by default. Code that calls a required module's functions
  imports from that module's part. Code that calls the syntax library, or
  uses `quote`, `quasiquote`, `quote-syntax` or `quasisyntax`, imports from
  `"syntax"`.
- **A module owns its memory and table, or takes them from a module it
  requires.** `(memory pages)` defines memory 0. `(memory from name)`
  imports the memory of the module required as `name` at the same phase, so a
  program's modules can share one memory. Tables likewise. Code that uses
  memory instructions or data segments needs a memory, and code that uses
  `func-index` or `call-indirect` needs a table. [v0] At phase ≥ 1 only the
  `from` form is supported.
- A part exports its memory as `"memory"` and its table as `"table"` (the
  host relies on this, section 4), and every module-level function and
  global under its name. If two bindings share a name, the compiler appends
  `.<n>` to later ones.

### 3.4 Runtime-free modules

`(runtime-free)` declares that the program needs nothing beyond the host at
run time. After expansion, the compiler checks every part the program would
load: each may import only from the host and from the program's other
parts, and none may use GC types. The check runs after expansion because
macros can add dependencies the program never wrote.

### 3.5 Initialization

Globals whose initializer is a numeric literal get it as their wasm
constant initializer, and reference globals start as null. Then the part's
start function runs:

1. For each function whose table index the part takes (`func-index`),
   append it to the table and keep the index in a global. Build each quoted
   constant with the syntax library's functions and keep it in a global.
   These happen in the order the compiler meets them.
2. The remaining global initializers and module-level expressions, in
   source order.

Quoted fixnums and `#f` need no global: they are the constant expressions
`(ref.i31 n)` and `(ref.null eq)`. A phase-1 part's module-level
expressions run each time the part is instantiated, which is once per
compilation that needs it.

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
way stage0 uses the equivalent C functions; the embedder API also has a
variant that instantiates a part at a shift (3.2). An instantiated module can reach
exactly what its imports name, so compile-time code runs sandboxed.
[v0: all five, tested from kernel code in `tests/hook.sub`.]

## 5. The kernel language

The kernel is WebAssembly written as S-expressions, plus bindings,
quotation and compile-time forms.

### 5.1 Types

- Numbers: `i32`, `i64`, `f32`, `f64`.
- References: `anyref`, `eqref`, `i31ref`, `structref`, `arrayref`,
  `funcref`, `externref`, and `(ref T)` or `(ref null T)` where `T` is one
  of `any eq i31 struct array func extern none` or a declared type.
- A function result is written `-> t` or `-> (t ...)`, or omitted when
  there is none. Function types in imports and `call-indirect` are written
  `(t ... -> t ...)`.
- Types are checked with wasm's subtyping: `(ref T)` fits where
  `(ref null T)` is expected, a declared struct type fits `structref`,
  every struct, array and `i31ref` fits `eqref`, and so on.

### 5.2 Module-level forms

```
(func (name [param type] ...) [-> result] body ...)
(global name type init)             ; numeric or nullable reference type
(import name "module" "field" (type ... -> type ...))
(memory pages)  (memory from name)
(table size)  (table from name)
(data name offset "bytes" ...)      ; active segment at offset in memory
(type name (struct (field fname ftype) ...))   ; ftype: storage or (mut storage)
(type name (array ftype))                      ; storage: a type, i8 or i16
(require name source item ...)      ; source: "path" or syntax; item: x or [new old]
(provide id ...)                    ; phase 0 only
(runtime-free)                      ; see 3.4
(define-syntax name transformer)    ; transformer: a phase+1 function (2.1)
(define-static name expr)           ; expr is phase+1 code, run now
(begin-for-syntax form ...)         ; forms at phase+1
(begin form ...)                    ; spliced
expr                                ; runs at instantiation
```

A module body is expanded in two passes, as in Racket. The first pass
expands macro uses at the head of each form, registers definitions, runs
`define-static` and `begin-for-syntax` at once, processes `require`, and
splices `begin`. The second pass expands function bodies and expressions. So
functions may be mutually recursive, and a macro must be defined before it
is used. A transformer must come from an earlier `begin-for-syntax`, or
from a module required inside one. A declared type may refer to itself.

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
(op arg ... [offset])               ; a numeric or memory instruction, e.g. (i32.add a b)
(call-indirect (t ... -> t ...) index arg ...)
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
  an `if` may differ when one reference type contains the other, or both
  fit `eqref` or `anyref`.
- A call in tail position whose callee's result types fit the function's
  is emitted as `return_call`, so recursion in tail position runs in
  constant stack.
- Loads and stores take an optional trailing literal offset:
  `(i32.load p 8)`, `(i32.store p v 8)`.
- Labels are bindings and obey scope like variables.

### 5.4 Literals

Unquoted literals are wasm numbers. `quote` turns a literal into a value,
and needs the syntax library required at that phase.

| Source | Unquoted | Quoted |
|---|---|---|
| `42` | integer constant, type from context | fixnum value |
| `1.5` | float constant | not supported in v0 |
| `#\a` | `i32` 97 | character value |
| `#t` / `#f` | `i32` 1 / 0 | `#t` value / null |
| `"text"` | error: use `data` for bytes | string value |

The unchanged parts of a `quasisyntax` template keep their lexical context,
which is what macro templates need. The reader abbreviations are
`'` `` ` `` `,` `,@` and `#'` `` #` `` `#,` `#,@`. Integers outside the
fixnum range (31 bits) cannot be quoted.

### 5.5 Base bindings

Every module sees, at every phase, only the kernel forms and the wasm
numeric and memory operators. Everything else comes from a declaration in
the module: its own definitions, `import`, and `require`.

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
- A module-level definition of a name that is already defined with the same
  scope set at the same phase is an error. So is a reference whose best
  candidates have identical scope sets but different meanings.
- **Bindings outlive a module's compilation.** The binding table and scope
  ids last for the whole compiler run. A macro's template identifiers carry
  its module's scopes, so they keep resolving to its module's bindings,
  including ones it does not provide, when another module expands them.
- **Phases.** Bindings are recorded per phase, and a syntax object has one
  scope set. A module required at shift *s* ≠ 0 has its bindings installed
  at their phase + *s*, with its module scope replaced by a copy for that
  shift. The syntax literals its parts build when instantiated at shift *s*
  carry the same copy. So a module required at two shifts, which has
  bindings from both at the same phase (a macro `m` shifted up, next to the
  phase-1 function behind `m`), keeps them apart. This is Racket's
  per-phase module scopes, applied eagerly per shift; v0 shifts only module
  scopes.

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

A transformer can capture on purpose: `(datum->syntax stx 'it)` makes an
identifier with the scopes of the use, as if the user had written it.

### 6.3 Compile-time bindings

- `(define-syntax m f)`: `m` is a macro whose transformer is the phase+1
  function `f`, of type `(eqref) -> eqref`. `f` may come from a module
  required inside `begin-for-syntax`.
- `(define-static s expr)`: `expr` is compiled and run at phase+1 now, and
  `s` is bound to its value, an `eqref`. The value lives in a global of the
  phase+1 part, so another module that requires this one computes it again
  in its own compile-time store. Using `s` as an expression is an
  error, but macros read the value with `syntax-local-value`. This is how
  extensions share information, for example a struct form and a match form.

[v0] Stage0 expands in Chez, so syntax crosses between Chez and wasm by
copy, through the syntax library's embedder functions (appendix A). The
self-hosted expander will hold references directly and need no copy.

## 7. Open questions and later milestones

- **Reusing compiled modules across runs**: v0 compiles every required
  module in each run, and a compiled part is valid only in the run that
  produced it. Reuse needs a module's binding table written out with its
  parts, and scope ids relative to the module.
- **Per-phase scope sets in full**: v0 shifts only module scopes (6.1).
- **Memory and table definitions at phase ≥ 1**: v0 supports only
  `(memory from name)` there.
- **More require and provide forms**: re-exporting, renaming on provide,
  requiring several phases up without nesting `begin-for-syntax`.
- **Extension points**: `#%app`, `#%module-begin`, `local-expand`, syntax
  properties (the `props` field is always `()` in v0), lifting definitions
  out of expressions.
- **Type identity of library data**: wasm treats identical type
  definitions as the same type. A program type with the same shape as one
  of the syntax library's (a struct of two immutable `eqref` fields, say)
  would pass the library's type tests. Recursion groups can make the
  library's types distinct if this matters.
- **Seed without an engine**: a Zig-style seed translated to native code
  would need a GC implementation. Wastrel has one.
- **More kinds of data**: bignums, floats and vectors as values are not in
  v0.

## Appendix A: stage0's syntax library representation (not part of the contract)

This describes `compiler/syntax.sub` and `stage0/marshal.sls` as they are.
Macros must not depend on it; the compiler may, because it is part of the
expander.

- **Types** (each in its own recursion group):

  | Type | Definition | Holds |
  |---|---|---|
  | `%string` | `(array (mut i8))` | UTF-8 bytes |
  | `%pair` | `(struct (field car eqref) (field cdr eqref))` | pairs |
  | `%symbol` | `(struct (field name (ref %string)))` | symbols |
  | `%atom` | `(struct (field kind i32) (field value i32))` | characters (kind 0), `#t` (1), `()` (2) |
  | `%syntax` | `(struct (field e eqref) (field scopes eqref) (field srcloc eqref) (field props eqref))` | syntax objects |
  | `%srcloc` | `(struct (field source eqref) (field line i32) (field col i32) (field pos i32) (field span i32))` | source locations |
  | `%table` | `(array (mut eqref))` | the intern table and the handle table |

- **Values**: a fixnum is an `i31ref`. `#f` is null. `#t` and `()` are
  single `%atom` objects made at start. Quoted strings in compiled code are
  built with `array.new_fixed` of `%string`, which the compiler declares in
  the module; wasm makes it the same type as the library's.
- **Syntax objects** are wrapped eagerly: the datum of a list is a list
  whose elements are syntax objects. Scopes are a list of fixnum scope ids
  in ascending order; scope 0 is the core scope. The source of a srcloc is
  a symbol naming the file. Line is 1-based, column and position 0-based.
- **Memory**: the library's memory holds only its error messages.
- **Embedder interface (stage0 only)**: Chez cannot hold GC references, so
  it names objects by `i32` handles, indexes into the library's handle
  table (handle 0 is `#f`). The `%h-` functions build and take apart
  objects through handles. Handles made while a macro runs are released
  when it returns. Each store gets a small entry chunk per transformer and
  per static value it uses, which converts between handles and references.
  After bootstrap this section goes away.
- **Shifted literals**: `%set-scope-shift` tells `%make-syntax` to replace
  one scope id with another. Stage0 sets it around the instantiation of a
  part at shift *s* ≠ 0, mapping the module's scope to its copy for *s*
  (6.1), and clears it after.
