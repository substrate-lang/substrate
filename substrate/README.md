# substrate

Substrate is a Lisp over WebAssembly. Its kernel's main addition to wasm
is compile-time execution: macros are kernel code, compiled to wasm and run
by the same engine that runs the program. The hope is that different
languages can be built as libraries over one small kernel. The language
most code is written in, also called Substrate, is one of them.

`docs/spec.md` starts from its principles (section 1) and fixes what the
bootstrap must preserve: the macro contract, the units of compilation, and
the host interface.

## Layout

What each directory is, and how long it lives. Every source file's first
line says the same.

| Directory | What it holds | Lifecycle |
|---|---|---|
| `docs/` | the kernel specification | permanent |
| `host/` | the hosts, in C over wasmtime (`subhost.c`) and in JavaScript over Node's V8 (`subhost.mjs`): stores, linking, the `host` imports and the instantiate hook. The code that the JavaScript host shares with the browser is in `subhost-core.mjs`. `host/web` (experimental) runs programs in a web page, where a program can also run another program in a sandbox (`host/web/guest.mjs`); see "Web pages" in `next/README.md` | permanent: they run programs, the compiler among them |
| `compiler/` | the compiler, written in Substrate: reader, expander, kernel compiler, wasm encoder. It compiles itself (spec 1.4). And the kernel module (`kernel.sub`, in kernel code): the data of every language and the functions macros use on it, which the compiler carries into the programs that use them | permanent, grows |
| `lib/` | libraries, which programs use, the compiler among them: Substrate (`substrate.sub`, written in Substrate on its core in kernel code, `substrate-core.sub`), the language built on the kernel; and printing for programs without GC (`print.sub`) | permanent, grows |
| `examples/` | demos meant to be read, each a program `NAME.sub` (with `.out` and `.imports`) and any modules it requires in `NAME/`; checked by `make check` | grows |
| `tests/` | regression tests: `.sub` programs with `.out` (expected output) or `.err` (expected error), and `.imports` (what the compiled phase-0 linklet may import). `tests/fixtures/` holds modules the tests require, and a directory such as `tests/bend/` holds a language's tests, with fixtures of their own | grows |
| `seed/` | the compiler, built by itself: what builds the compiler's source (spec 1.4) | permanent, replaced as the compiler grows |
| `bin/sub` | runs the compiler written in Substrate (`build/sub`) | permanent |

A library in `lib/` is one we intend to build on, not the only way to do
what it does: languages on the kernel can bring their own. If one turns out
to be only illustrative, it moves to `examples/`.

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
bin/sub kernel -o build/kernel.wasm      # write the kernel module, and its compiled file beside it
wasm-tools print OUT            # inspect a module
HOST=build/subhost bin/sub ...  # run the compiler on wasmtime rather than V8
HOST=host/subhost.mjs tests/run.sh   # run the tests' programs on V8
SUBHOST_PERFMAP=1 HOST=build/subhost perf record -g bin/sub ...   # wasmtime samples, named by wasm function
```

bin/sub runs the compiler, `build/sub`, on V8, from the package root, so
that a module's bytes, which name its source, are the same wherever it is
built from (spec 3.6); it keeps the modules it compiles in `build/cache`
(spec 3.7), and `rm -rf build/cache` starts over. `make build/sub` builds it
from the checked-in seed (`seed/`): the seed builds the source, and that
build builds it again. `make bootstrap` checks that `build/sub` builds
itself into the same bytes, its fixpoint (spec 1.4), and `make seed` makes
`build/sub` the seed, once it does.

## Status

The compiler is written in Substrate (`compiler/`) and compiles itself: it
is built from a checked-in seed, reaches its fixpoint (`make bootstrap`,
spec 1.4), and on V8 builds itself in under a second. It was first built
by stage0, a compiler written apart in Chez Scheme, which wrote the same
bytes; stage0 was retired after commit 3e74bce.

The compiler goes from source to a program: reader, expander, kernel
compiler, binary wasm, which a host runs on wasmtime or V8. Errors and
traps name the source: a backtrace gives each frame's file, line and
column, and a trap in a macro is reported where the macro was used (spec
3.6, 4). Macros work end to end: a
transformer is a phase-1 function over GC syntax objects, compiled and
instantiated in the compile-time store and called by the expander.
Compile-time values (`define-syntax`, `syntax-local-value`),
`raise-syntax-error`, `free-identifier=?`, `identifier-binding-kind` and
syntax properties work too, and macros are hygienic
(introduction and use-site scopes, spec 6.2). The kernel has wasm's
exception handling (tags, `throw`, `try`), and Substrate has `raise` and
`with-handlers`; errors are exceptions, and one that nothing handles
stops the program where it happened, with its backtrace. Syntax errors
are exceptions too, so a macro can handle one from `local-expand`. Substrate's
`syntax-match` takes syntax apart with patterns written in its shape;
the expander parses the kernel's forms with it, and its errors are written
from the patterns. A module can change what
application and literals mean by binding `#%app` and `#%datum` (spec 5.3,
5.4). Expansion produces fully expanded code, syntax in a fixed grammar (spec
6.4): a macro can see its input's with `local-expand`, and `bin/sub expand`
prints it. A macro that needs the whole module expands into a core
expression form, whose contents the module body's second pass expands
once every definition is declared (spec 5.2). A module can record facts about a
definition, a datum or syntax, `(#%fact id 'datum)` or `(#%fact id #'stx)`,
which every module that requires it,
directly or not, reads with `syntax-local-facts`: how a language finds
what no name leads to.
Modules `require` each other by name, with
qualified imports (`print:write-int`), at any phase:
each phase of a module compiles to its own wasm module, a linklet, and a
program loads only the linklets it reaches at run time (spec 3). Compiled programs import
only what they use:
`(freestanding)` is checked by the compiler, and `.imports` files check
imports in the tests and examples.

In `examples/shapes.sub`, libraries work together: `struct` and `enum`
define GC types and leave compile-time values that `match` reads,
checking patterns at compile time, and the program matches, in one
module, types defined in another.
`lib/substrate.sub` is Substrate, the language the compiler is written
in, on the Substrate kernel: every value is an `eqref`, and its lambdas
are the kernel's closures (spec 5.3), of one signature, a count and the
first four arguments. `examples/effects.sub` is an effect language on Substrate (`examples/effects/handlers.sub`): declared effects, handlers
with a clause per operation, and Koka's evidence passing, built from
`#%app`, `local-expand` and compile-time values. `examples/typed.sub` is
a typed language on the kernel (`examples/typed/typed.sub`): `Int`,
`Bool` and function types, checked as each function's body expands, in
the module's second pass; its lambdas are
the kernel's closures, one closure type per signature. A function's type
reaches the modules that import it through the
transformer its name is bound to. Generics are monomorphized: each
instance a module uses is made from the generic's
definition, which reaches other modules the same way; a generic is
checked once, where it is defined. Its data types, which may have type
parameters, are GC structs, a subtype of one base for each variant;
`match` checks that its clauses cover the variants, and tests the
struct's type. Its traits have impls, written with the trait or the
type, which are facts about the trait: a method call finds the impl for
its type among them, and calls the impl's function for that type
directly. A generic's type parameter can need a trait, whose methods its
body can then use. A trait can have associated types, which each impl
gives: a type `(Elem C)` is the one `C`'s impl gives, found the same way,
and the checker compares types once such projections are reduced.
`examples/bend.sub` is Bend on the kernel (`examples/bend/`): a port of
Bend2's kernel, a dependently typed language with quantities, in
s-expressions. Its kernel, `core.sub`, checks each module's definitions
in order while the module compiles: datatypes, definitions by pattern
matching, which terminate by descent, and proofs by rewriting. A term's
binders expand to kernel lambdas, so the expander keeps them hygienic,
and its other nodes to quoted data; each definition reads its expansion back
as a term and records it as a fact about its name, which the checker
looks up by name when a term refers to it (spec 6.5, 6.6). A law
declares a definition that a later one, in any module that requires it,
fills. Each definition with a value is then a function
(`lower.sub`), with every value an `eqref`: a datatype a recursion group
of structs, one per constructor, a function value a closure, and what is
erased, types, proofs' rewrites and binders of quantity `-`, left out.
A def whose first parameters are `~` is a template, as in Bend: an
application gives it closed template arguments first, and is of its
instance at them, a definition of its own, made by putting them for its
parameters, so a function argument is called directly, or put in place
if it is a lambda. A module shares the instances that the modules it
requires made.
Kernel code calls a definition directly, with its live arguments, and
`(print e)` writes a term's value; the example's `main` is kernel code,
as the others' are.

Open questions are in `docs/spec.md` section 7.
