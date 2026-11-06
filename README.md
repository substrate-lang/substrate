# substrate

Substrate is a Lisp for writing WebAssembly. It has C-like semantics
(modernized with generics, variants, bounds-checked slices), combined with
Racket-style hygienic macros and module hooks for defining new languages and
DSLs. Its compiler is small (~11k LOC, <600 KiB of Wasm), very fast,
self-hosted, and runs in the browser.

## Install

```sh
npm install -g substrate-lang
```

This installs the `substrate` command. It needs Node 24 or newer.

## Running Substrate

`hello.sub`:

```racket
(define (main) (printf "Hello, world!\n"))
```

`substrate run` builds the program and runs it:

```console
$ substrate run hello.sub
Hello, world!
```

To build and run in separate steps:

```console
$ substrate build hello.sub -o build/hello
$ substrate run build/hello
Hello, world!
```

Substrate code is sandboxed by default and cannot access your filesystem or
network without grants. `cat.sub` prints a file:

```racket
(require-unqualified host/fs)

(define (main)
  (let ([text (slice u8)] [why string])
    (when (< (fs-read-file (@ (host-args) 0) (& text) (& why)) 0) (host-exit 1 why))
    (printf "~a" (cast string text))))
```

```console
$ substrate run cat.sub hello.sub
hello.sub: reading is not granted (--allow-read)
$ substrate run -R=hello.sub cat.sub hello.sub
(define (main) (printf "Hello, world!\n"))
$ substrate run -A cat.sub hello.sub
(define (main) (printf "Hello, world!\n"))
```

The grants are like Deno's. `-R`, `-W`, `-N` and `-E` grant reading, writing,
the network and environment variables, and `--allow-run` grants running
programs. Each can be limited to a list after `=`, as in `-R=hello.sub`. `-A`
grants everything.

A program can also run in a browser. `page.sub` puts a heading on the page with
`std/web`:

```racket
(require-unqualified std/web/dom)

(define (main)
  (dom-add! (dom-template "<h1>Hello, world!</h1>") 0 0)
  (dom-flush!))
```

`substrate site` builds a site for it, and `substrate serve` serves the site
locally:

```console
$ substrate site page.sub -o build/page
$ substrate serve build/page
http://127.0.0.1:8000/
```

These examples are in [examples/hello](examples/hello).

## Core Language

[examples/core.sub](examples/core.sub) uses structs, variants, strings, slices
and generics:

```racket
(struct point [x i32] [y i32])

(variant shape [square [side i32]] [rect [w i32] [h i32]])

(define (area [s shape]) -> i32
  (match s
    [(square side) (* side side)]
    [(rect w h) (* w h)]))

(define #:forall (T) (largest [items (slice T)]) -> T
  (let ([best (@ items 0)])
    (for ([i u32 1]) (< i (-> items length)) (+= i 1)
      (when (> (@ items i) best) (set! best (@ items i))))
    best))

(define (main)
  (let ([p (point #:x 3 #:y 4)])
    (printf "point: ~a, ~a\n" (-> p x) (-> p y)))
  (printf "areas: ~a, ~a\n" (area (square 3)) (area (rect 6 7)))
  (let ([name "Substrate"])
    (printf "~a has ~a bytes and starts with ~a\n" name (-> name length) (slice name 0 3)))
  (printf "largest: ~a, ~a\n" (largest (slice (array-of i32 3 9 4))) (largest (slice (array-of f64 1.5 0.5))))
  (let ([xs (slice (array-of i32 1 2 3))])
    (printf "~a\n" (@ xs 3))))
```

Its last line reads past the end of a slice, so the program traps there:

```console
$ substrate run core.sub
point: 3, 4
areas: 9, 42
Substrate has 9 bytes and starts with Sub
largest: 9, 1.5
error: trap: index 3 is out of range for length 3
    at index-trap compiler/substrate.sub:201:5
    at main ./core.sub:24:20
```

## Packages

A package is a folder with a `package.sub`, or a program whose first form is
its manifest. A dependency is the path of a folder, or the URL of a tar.gz
archive, pinned by a hash of its files. `substrate fetch` prints the dependency
for a URL, with its hash:

```console
$ substrate fetch https://github.com/substrate-lang/example-package/archive/refs/tags/v0.1.0.tar.gz
substrate: fetching https://github.com/substrate-lang/example-package/archive/refs/tags/v0.1.0.tar.gz
(example-package (url "https://github.com/substrate-lang/example-package/archive/refs/tags/v0.1.0.tar.gz") (hash "sha256:6f07dd7bf3effd4fbe20233479401fa63b1ec37567645401fcbf4c744df44105"))
```

[examples/packages/greeting.sub](examples/packages/greeting.sub) depends on it:

```racket
(package greeting
  (version "0.1.0")
  (dependencies
   (example-package (url "https://github.com/substrate-lang/example-package/archive/refs/tags/v0.1.0.tar.gz")
                    (hash "sha256:6f07dd7bf3effd4fbe20233479401fa63b1ec37567645401fcbf4c744df44105"))))

(require example example-package)

(define (main) (example:banner "Hello from a package"))
```

Building it fetches the dependency into `build/packages`:

```console
$ substrate build greeting.sub -o build/greeting
substrate: fetching https://github.com/substrate-lang/example-package/archive/refs/tags/v0.1.0.tar.gz
$ substrate run build/greeting
+----------------------+
| Hello from a package |
+----------------------+
```

## Languages and Metaprogramming

A macro is a function that runs at compile time and turns syntax into syntax.
Macros are hygienic: the `tmp` that `swap!` introduces is not the caller's
`tmp`. [examples/swap.sub](examples/swap.sub):

```racket
(require-unqualified compiler/macros)
(begin-for-syntax (require-unqualified compiler/macros))

(define-macro (swap! stx)
  (syntax-match stx
    [(_ a b) #`(let ([tmp #,a]) (set! #,a #,b) (set! #,b tmp))]))

(define (main)
  (let ([tmp 1] [other 2])
    (swap! tmp other)
    (printf "~a ~a\n" tmp other)))
```

```console
$ substrate run swap.sub
2 1
```

Languages are packages too. [examples/bend2/proof.sub](examples/bend2/proof.sub)
is written in bend2, a port of [Bend 2](https://github.com/bendlang/bend) whose
type checker runs at compile time. It proves by induction that adding zero to a
number gives the number back:

```racket
(package proof
  (version "0.1.0")
  (dependencies
   (bend2 (url "https://github.com/substrate-lang/substrate-bend2/archive/refs/tags/v0.9.0.tar.gz")
          (hash "sha256:9729bf4cd8de04de38200a4bdcda6d216fb9c9d9ee3b4044912211663e7d1eea"))))

(language bend2)

(type N Data [Z] [S [p : N]])

(law (add [a : N] [b : N]) N)
(def (add a b)
  (match a
    [Z b]
    [(S p) (S (add p b))]))

(law (add_zero [a : N]) (== (add a Z) a N))
(def (add_zero a)
  (match a
    [Z refl]
    [(S p) (rewrite (add_zero p) (== (S (add p Z)) (S _) N) refl)]))

(define (main) (print (add (S (S Z)) (S Z))))
```

```console
$ substrate run proof.sub
substrate: fetching https://github.com/substrate-lang/substrate-bend2/archive/refs/tags/v0.9.0.tar.gz
(S (S (S Z)))
```

A false claim does not compile. [examples/bend2/false.sub](examples/bend2/false.sub)
has the same type and `add`, and claims that 2 + 1 is 2:

```racket
(law (two_plus_one) (== (add (S (S Z)) (S Z)) (S (S Z)) N))
(def (two_plus_one) refl)
```

```console
$ substrate build false.sub -o build/false
false.sub:18:21: error: bend: expected (S (S (S Z)))
  observed (S (S Z))
  in: refl
```

## Memory Management

Memory is managed by hand, as in C. Locals live on the stack, and `&` gives
their address. `malloc` and `free` manage the heap, arenas free many
allocations at once, and buffers grow as they are written.
[examples/memory.sub](examples/memory.sub):

```racket
(struct node [value i32] [next (ptr node)])

(define (main)
  (let ([n (cast (ptr node) (malloc (sizeof node)))])
    (set! (-> n value) 7)
    (printf "malloc: ~a\n" (-> n value))
    (free n))
  (let ([a (make-arena)] [list (ptr node) 0])
    (for ([i 1]) (<= i 1000) (+= i 1)
      (let ([cell (new (& a) node)])
        (set! (-> cell value) i)
        (set! (-> cell next) list)
        (set! list cell)))
    (printf "arena: ~a ~a ~a\n" (-> list value) (-> list next value) (-> list next next value))
    (arena-free (& a)))
  (let ([b (make-buffer)])
    (buffer-add-string! (& b) "grows ")
    (buffer-add-string! (& b) "as needed")
    (printf "buffer: ~a\n" (buffer-string (& b)))
    (buffer-free! (& b))))
```

```console
$ substrate run memory.sub
malloc: 7
arena: 1000 999 998
buffer: grows as needed
```

The core also has `calloc`, `realloc`, `memcpy`, `memset`, `memcmp` and hash
tables. `malloc` traps when memory runs out, where `try-malloc` gives 0, and
freeing a block twice traps.

## Testing

`substrate test` runs a package's tests. [examples/hello](examples/hello) is a
package:

```racket
(package hello
  (version "0.1.0")
  (tests "tests/*.sub" (browser)))
```

`(browser)` says that some of its tests open a browser. `tests/square.sub`
tests the function in `square.sub`:

```racket
(provide square)

(define (square [n i32]) -> i32 (* n n))
```

```racket
(require-unqualified "../square.sub")

(test square (expect-equal (square 7) 49))
```

`tests/page.sub` opens `page.sub` in Chromium:

```racket
(require-unqualified std/test/browser)

(test page
  (with-browser (b "../page.sub")
    (expect-text b (by-css "h1") "Hello, world!")))
```

```console
$ substrate test -v
ok hello/tests/page.sub:3 page
ok hello/tests/square.sub:3 square
hello: 2 passed (0.2 s)
```

Browser tests need Chrome or Chromium. Without either, `substrate test` skips
them.

## Performance

On realistic workloads, Substrate takes 0.35–1.4× the time of C compiled to
Wasm with clang -O2, though its compiler is much faster: it compiles about
47,000 lines a second, its own 11,000 in 0.24 s, where clang compiles C to Wasm
at 9,000–17,000 lines a second at -O2.

Substrate's libraries against C libraries, as Substrate's time over C's, on an
AMD Ryzen 9 9950X with Node 24 on Linux:

| Workload              | Against | Substrate / C |
| --------------------- | ------- | ------------: |
| JSON parsing          | cJSON   |     0.35–0.96 |
| SHA-256, HMAC, PBKDF2 | mbedTLS |     0.79–1.39 |
| Deflate and inflate   | zlib    |     0.74–1.23 |

On 12 small programs written the same way in both languages, Substrate's
median is 1.4× C's time. [docs/bench.md](docs/bench.md) has every result and
how to run the benchmarks.

## Supported Platforms

Substrate runs on macOS, Linux and Windows, with Node 24 as its host, and CI
runs its tests on all three. We chose Node (V8) as the first host, but nothing
blocks a Wasmtime host in the future.

## Contributing

Code may be written with LLMs. Text in pull requests, comments and docs must be
written by humans.

The toolchain comes from the Nix flake. In its dev shell (`nix develop`):

```sh
bin/substrate    # the substrate command, built from this checkout
make check       # the tests, then make docs when they pass
make bootstrap   # the compiler builds itself into the same bytes
make seed        # the bootstrap check, then the compiler and substrate become the seed
make docs        # documentation of the toolchain, as HTML in build/doc
make npm         # the npm package, packed into build and tried in a temporary install
```

[docs/README.md](docs/README.md) describes the repository's layout and lists
every command.
