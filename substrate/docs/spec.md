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
| libraries | Ordinary modules: printing, `define-macro`, structs and `match`. | `lib/*.sub` |
| languages | Libraries that together make a language, such as the planned dynamic Lisp. | not yet |

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
| strings and symbols | `(string? v) -> i32`, `(string-length s) -> i32`, `(string-byte s i:i32) -> i32`, `(string=? a b) -> i32`, `(string-append a b)`, `(make-string-builder)`, `(string-builder-add-byte! b byte:i32)`, `(string-builder-add! b s start:i32 end:i32)`, `(string-builder->string b)` (a new string, or `#f`), `(symbol? v) -> i32`, `(symbol->string s)`, `(intern s)`, `(symbol-append a b)`, `(symbol-hash s) -> i32` |
| syntax | `(syntax? v) -> i32`, `(syntax-e s)`, `(identifier? v) -> i32`, `(syntax->list v)` (a list, or `#f`), `(syntax->datum v)`, `(datum->syntax ctx d loc)`, `(syntax-rewrap s e)`, `(splice-list v)`, `(syntax-property s key)` (the value, or `#f`), `(syntax-property-set s key value)` |
| queries | `(syntax-local-value id)` (the value bound by `define-static`, or `#f`), `(syntax-error stx msg)` (aborts expansion, blamed on `stx`; returns nothing), `(free-identifier=? a b) -> i32`, `(binding-kind id)`, `(local-expand stx)`, `(lift-definition form)` |

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
- Accessors trap with a message ("expected a pair") when given the wrong
  kind of value.
- `free-identifier=?` is 1 when `a` and `b` refer to the same bindings at
  the running macro's phase, as a value and as a type (6.1). An imported
  name and the definition it imports are the same binding. Two identifiers
  bound in neither namespace are equal when their names are.
- `binding-kind` says what identifier `id` is bound to as a value at the
  running macro's phase: the symbol `function`, `variable` (a local or
  global), `macro`, `static`, `data`, `label` or `core` (a core form or wasm
  operator); `type` if it is bound only as a type; or `#f` if it is
  unbound. An implicit `#%app` (5.3) uses it to
  tell a call of a function from a call through a variable.
- `local-expand` expands expression `stx` at the running macro's phase and
  returns it as expanded code (6.4), so a macro can look at what its input
  becomes, and put the result in its output. As in Racket, the macro's
  introduction scope is flipped around the expansion, so code from the
  macro's input expands as it would at the use site.
- `lift-definition` adds a module-level form (a `func`, `global`,
  `import`, `type` or `data` form, or an expression) to the module body
  being expanded, at the running macro's phase (6.4). It returns the form
  as it is declared: with the macro's introduction scope, like the
  macro's output, so each use gets fresh names.

The queries only work while an expander is running. [v0] Stage0 answers
them in Chez; in a run-time store they trap.

## 3. Modules, parts and linking

### 3.1 Modules and parts

- One source file is one module. A module's code at one phase compiles to
  one wasm module, called a **part**. Phase 0 is the program. Phase *n*+1
  code runs while phase *n* is expanded, so a module's phase-1 part holds
  its transformers, its `define-static` values and its `begin-for-syntax`
  code.
- `(provide item ...)` names the phase-0 bindings other modules get:
  functions, globals, macros, static values, types and data, whether the
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
    in, such as its `define` and `#%app`, and little else, since
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
  its phase ≥ 1 code is also compiled and instantiated in **chunks**, one
  per `begin-for-syntax` or `define-static`, in source order. When the
  module is done, each phase's code is compiled again as a whole, into the
  part. Other modules only ever use the parts.

### 3.2 Stores and instance names

- Each module is compiled with a fresh compile-time store. The module's
  own chunks, and the parts of the modules it requires, are instantiated
  there on demand. So no compile-time state is shared between the
  compilations of two modules, as in Racket. Compiled wasm code is not
  state: the host compiles a part's bytes once and instantiates the result
  in every store that needs it.
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
  `func-index` or `call-indirect` needs a table. At phase ≥ 1 these work the
  same way. There the chunks of a phase (3.1) share one memory: the first
  chunk after `(memory pages)` defines it and later ones import it, so, as
  with macros, code can use it only after the declaration. Tables likewise.
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

A global whose initializer is a constant expression (5.2) gets it as its
wasm initializer. The others start at their type's default, zero or null.
Then the part's start function runs:

1. For each function whose table index the part takes (`func-index`),
   append it to the table and keep the index in a global, in the order the
   compiler meets them.
2. Build the part's quoted data.
3. The other global initializers and module-level expressions, in
   source order.

Quoted fixnums and `#f` are the constant expressions `(ref.i31 n)` and
`(ref.null eq)`, and `'()` and `#t` read immutable globals the syntax
library defines for them, also a constant expression. The compiler
serializes the part's other quoted data into one passive data segment,
which the syntax library turns into a table of objects when the part
starts; code reads a quoted datum from the table. So compiled code does
not grow with its literals, and each is built once per instance. As in
Scheme, equal quoted data may share structure: whether two quoted data,
or parts of them, are the same reference is unspecified, except that a
quoted string, which is mutable, is never shared.

A phase-1 part's module-level expressions run each time the part is
instantiated, which is once per compilation that needs it.

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
| `instantiate` | `(name name-len bytes bytes-len shift) -> i32` | compile and instantiate the wasm module in `bytes`, link its imports by name, and register it as `name`. At `shift` > 0, each import from a part `<module>@<phase>+<t>` links to `<module>@<phase>+<t + shift>` instead (3.2). 0 on success. |
| `export_index` | `(inst inst-len field field-len) -> i32` | append the function `inst.field` to the caller's table (exported as `"table"`) and return its index, or -1 |
| `error_message` | `(buf cap) -> i32` | copy the last `instantiate` error into `buf`; returns its length |

`instantiate` is **the hook**: wasm cannot make new code executable by
itself, and this is how it does. The self-hosted compiler will use it the
way stage0 uses the equivalent C functions. An instantiated module can reach
exactly what its imports name, so compile-time code runs sandboxed.
[v0: all five, tested from kernel code in `tests/hook.sub`.]

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
  as `lib/struct.sub` does with a brand per variant and the Lisp's records
  with a descriptor.
- **Type functions.** In a type position, a form whose head is a macro is
  expanded until it is not, so a compile-time function can compute a
  type: `(ref (tuple i32 3))`, as in Zig. Such a macro usually declares the
  type with `lift-definition` and returns its name. Uses in any module get
  the same type, since the declarations have the same structure; the macro
  can remember a name to declare the type once per module
  (`tests/fixtures/tuple.sub`).
  Type positions are the types of parameters, results, globals, `let`
  bindings, fields and signatures, and the type immediates of GC
  instructions.

### 5.2 Module-level forms

```
(func (name [param type] ...) [-> result] [(type T)] body ...)   ; T: a function type
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
(runtime-free)                      ; see 3.4
(module-pass f)                     ; phase 0; f: a phase+1 function (6.5)
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
from a module required inside one.

A macro used at module level runs in the first pass, so it sees only the
definitions before it; `binding-kind` reports a later one as unbound. A
macro that needs the whole module can expand into a core expression form,
such as `let`, whose contents wait for the second pass. Module-level
applications and literals are expressions: their implicit `#%app` and
`#%datum` (5.3, 5.4) are applied in the second pass, when every
definition is known. Racket applies `#%app` in the first pass, which is
harmless there because its `#%app` does not depend on what the function
is; here a language's `#%app` usually does (`binding-kind`). So an
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
- **Application is an implicit form**, as in Racket. A form whose head is
  not bound to a macro, a core form or a wasm operator, including one
  whose head is not an identifier, is expanded as `(#%app head arg ...)`.
  The `#%app` identifier gets the scopes of the form, so it means what
  `#%app` is bound to where the form was written, not where it is
  expanded. A module changes the meaning of its applications by binding
  `#%app` to a macro, usually by importing one:
  `(require dl "dynlisp.sub" [#%app app])`. Code a macro introduces keeps
  its own module's `#%app`. The core `#%app` calls a function directly and
  rejects anything else. A macro standing for `#%app` must not return an
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
Values are syntax-library data, so a part that quotes imports from the
syntax library, as it would for any library function it calls; at phase 0
that is visible in what the program links, and `(runtime-free)` rejects
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
as the symbol `#%name`. An integer literal must fit in 64 bits, from -2^63
to 2^64 - 1, and a number literal is an integer or a decimal: the reader
rejects others, such as `1/2`.

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
  and its constructor or static information.

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
  shift. So a module required at two shifts, which has bindings from both
  at the same phase (a macro `m` shifted up, next to the phase-1 function
  behind `m`), keeps them apart. The syntax literals a part builds when
  instantiated at shift *t* are shifted the same way: every module scope in
  them, module *X*'s copy for shift *s*, becomes *X*'s copy for *s* + *t*.
  A literal can hold other modules' scopes as well as its own module's,
  for example when another module's macro wrote part of its code. Only
  module scopes shift; introduction and use-site scopes, and the core
  scope, mean the same at every phase. This is Racket's per-phase module
  scopes, applied eagerly per shift.

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

### 6.4 Expanded code

Expansion turns a module into **expanded code**: syntax in the grammar
below, with every macro use expanded and every application and literal
explicit. `local-expand` returns it, module passes receive and return it,
`subc expand` prints it, and the compiler compiles it.

```
form ::= (func (id [id type] ...) [-> result] [(type id)] expr ...)
       | (global id type expr) | (global id (mut type) expr)
       | (import id "module" "field" (type ... -> type ...)) | (import id "module" "field" id)
       | (type id def) | (rec (type id def) ...) | (data id offset "bytes" ...)
       | expr

expr ::= id                                   ; a local or global variable
       | (#%datum literal)                    ; a wasm number, typed by context
       | (quote datum) | (quote-syntax datum)
       | (#%app id expr ...)                  ; a direct call; id names a function
       | (op expr ... [offset])               ; a wasm numeric or memory operator
       | (gc-op immediate ... expr ...)       ; struct.new, ref.cast, ... (5.3)
       | (let ([id expr] | [id type expr] ...) expr ...)
       | (set! id expr) | (begin expr ...) | (if expr expr [expr])
       | (block id expr ...) | (loop id expr ...)
       | (br id [expr]) | (br-if id expr) | (return [expr])
       | (call-indirect (type ... -> type ...) expr expr ...)
       | (ref.func id) | (call-ref id expr expr ...)
       | (func-index id) | (data-address id) | (data-size id)
       | (select expr expr expr) | (drop expr) | (unreachable) | (nop)
```

- The other module-level forms (`require`, `provide`, `memory`, `table`,
  `runtime-free`, `module-pass`, `define-syntax`, `define-static`,
  `begin-for-syntax`) take effect during expansion and leave nothing.
  `let*` becomes nested `let`s. `quasiquote` and `quasisyntax` become
  calls to the syntax library's functions, through identifiers with a
  scope of their own that no module's code has, so user code cannot name
  them.
- Types appear where the source wrote them: parameters, results,
  globals, and `let` bindings that give one. Expanded code carries no
  inferred types; the kernel's checker infers them after the passes, as
  it does for any code. Type functions (5.1) are expanded: types in
  expanded code contain no macro uses.
- **The core forms in expanded code are named by identifiers with only the
  core scope**, so they mean the core forms in any module, whatever it
  binds, for example its own `let` or `#%app`. Every other identifier keeps
  its scopes and resolves as before.
- **Expanded code can be expanded again**, with the same meaning. Its
  binding forms bind again under fresh scopes, which the references inside
  them get too. So a macro can put `local-expand`'s result into its
  output.
- **Lifted definitions** (`lift-definition`, 2.3) are declared as soon as
  they are lifted, so their names can be used at once, and their expanded
  code goes before the module-level form whose expansion lifted them.

### 6.5 Module passes

`(module-pass f)` declares that once the module is expanded, the phase+1
function `f`, of type `(eqref) -> eqref` like a transformer, rewrites the
module's phase-0 expanded code. Passes run in the order they are declared.
A library usually provides a macro that expands into the declaration.

- A pass gets the module's forms as one syntax list and returns a list of
  forms, as a syntax list or a plain list. It may add, remove and rewrite
  forms, and write any code, not only expanded code.
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
- Racket reaches a module's expanded code through `#%module-begin` and
  `local-expand` of the whole body. The kernel has no `#%module-begin`: a
  library that wants a module's body gets it by having the module wrap the
  body in one of its macros, and a pass works on the expanded result.

## 7. Open questions and later milestones

- **Inferred types in expanded code**: expanded code carries only the
  types the source wrote (6.4). A pass that creates wasm declarations from
  the code it rewrites, such as CPS for general effect handlers or closure
  conversion for a typed language, would need the checker to write types
  into expanded code before the pass, and queries for the types of
  imported definitions. Nothing planned before bootstrap needs this.
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
  | `%syntax` | `(struct (field e eqref) (field scopes eqref) (field srcloc eqref) (field props eqref))` | syntax objects |
  | `%srcloc` | `(struct (field source eqref) (field line i32) (field col i32) (field pos i32) (field span i32))` | source locations |
  | `%table` | `(array (mut eqref))` | the intern table, the handle table and a part's quoted data |
  | `%integer` | `(struct (field negative i32) (field magnitude i64))` | integers beyond the fixnum range |
  | `%flonum` | `(struct (field value f64))` | flonums |
  | `%builder` | `(struct (field bytes (mut (ref %string))) (field length (mut i32)))` | string builders |

- **Values**: a fixnum is an `i31ref`. `#f` is null. `#t` and `()` are
  single `%atom` objects made at start. A part's quoted data is a
  `%string` made with `array.new_data` from its data segment, which
  `%deserialize` turns into a `%table` of objects (the format is in
  `compiler/syntax.sub`). The compiler declares these types in the part;
  wasm makes them the same types as the library's.
- **Syntax objects** are wrapped eagerly: the datum of a list is a list
  whose elements are syntax objects. Scopes are a list of fixnum scope ids
  in ascending order; scope 0 is the core scope. The source of a srcloc is
  a symbol naming the file. Line is 1-based, column and position 0-based.
  Properties are a list of `(key . value)` pairs, newest first, with each
  key at most once.
- **Memory**: the library's memory holds its error messages, and from
  address 1024 the buffer stage0 copies values through.
- **Embedder interface (stage0 only)**: Chez cannot hold GC references, so
  it names objects by `i32` handles, indexes into the library's handle
  table (handle 0 is `#f`). A value crosses whole, in the format of a
  part's quoted data, through the buffer: stage0 writes the bytes and
  `%h-deserialize` builds the objects, or `%h-serialize` writes a value
  and stage0 reads the bytes. A value the format has no kind for crosses
  as a handle. Handles made while a macro runs are released when it
  returns. Each store gets a small entry chunk per transformer and
  per static value it uses, which converts between handles and references.
  After bootstrap this section goes away.
- **Shifted literals**: `%scope-map-add` tells `%make-syntax` to replace
  one scope id with another. Stage0 records which module and shift each
  module scope stands for, and each part lists the module scopes in its
  literals. Around the instantiation of a part at shift *t* ≠ 0 it maps
  each of them to its copy for its shift + *t* (6.1), and clears the map
  after (`%scope-map-clear`).
