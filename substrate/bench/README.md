# bench

Benchmarks, each directory with a `run.sh` that builds its programs with
`bin/sub`, runs them and prints a table. Times are wall-clock, the least
of N runs (default 3), in ms, and include the engine's start: about 10 ms
for wasmtime (`build/subhost`) and 70 to 80 ms for V8 (node, run with its
optimizing compiler only, `--no-liftoff`). Everything runs in the dev
shell, and a run should have the machine to itself. The tables below are
from one machine on one day; they are for reading the ratios, and for
noticing a change, not for reporting.

- `base/`: the C-like Lisp against C. Twelve programs, each `NAME.sub`
  and `NAME.c` the same program, C built with clang natively, for wasm,
  and for wasm without inlining, which the kernel does not do for C
  functions; all allocate with the same K&R malloc (`bench.h`).
- `substrate/`: Substrate's programs: six microbenchmarks (fixnum
  arithmetic, walking a list, making and freeing pairs, closure calls, a
  list benchmark, one of closures, structs and a hash table) and three
  untuned programs (an interpreter, N-queens, strings), on wasmtime and
  V8.
- `bend/compile/`: checking and compiling Bend. `proofs.sh N` writes a
  module of N blocks of proofs by induction and rewriting, the shape of
  Bend2's `proofs_3200`; `run.sh N` builds it, Bend's own modules already
  in the cache, and prints the wall time and the compiler's maximum
  resident size on each engine.
- `compare/`: the same three programs in the C-like Lisp, Bend and
  Substrate, each `NAME/{base,bend,substrate}.sub`: `fib` (calls and
  arithmetic), `trees` (binary trees made, counted and freed) and `lists`
  (a list built, mapped, filtered and summed). The three must print the
  same result; `ENGINE=v8` runs them on V8.

```sh
bench/base/run.sh [N [NAME ...]]
bench/substrate/run.sh [N [NAME ...]]
bench/bend/compile/run.sh [N]
bench/compare/run.sh [N [NAME ...]]
```

## The C-like Lisp against C (`bench/base`)

```
benchmark result                  ours  native  c wasm no inline  /native  /c wasm  /no inline
callback  50004900000              448      28      76       398    16.19     5.91        1.13
complex   61981                     98      25      27        94     3.96     3.64        1.04
errors    40000005000000           320       6      11        22    52.41    28.67       14.29
expr      871057366088             154     113     156       155     1.37     0.99        0.99
fib       39088169                 174     111     135       135     1.58     1.29        1.29
hash      8000002000000            440     321     327       435     1.37     1.35        1.01
matmul    2053125000                81      22      53        52     3.61     1.54        1.54
nbody     -169083133               243     181     232       236     1.34     1.05        1.03
sieve     5761455                  458     467     462       464     0.98     0.99        0.99
sort      16105365671030609        679     329     357       525     2.07     1.91        1.29
trees     14592688                 144     112     137       171     1.29     1.05        0.84
vec       149999985000000          101      39      48        78     2.58     2.09        1.29
```

Against C compiled to wasm without inlining, which is what the kernel
compiles, the C-like Lisp is within a third on all but two: `errors`,
where its exceptions cost 14 times C's error returns, and `callback`,
calls through a function pointer, a tenth. The gap to C with inlining is
inlining, which the compiler does not do for C functions (`matmul`,
`sort`, `vec`), and to native C the engine's.

## Substrate (`bench/substrate`)

```
benchmark     result                    wasmtime        v8
big-arith     89999995                       186       187
big-traverse  299985000000                   151       166
big-conses    30000000                       262       256
big-calls     30000000                       139       144
lists         4000800060                     213       210
closures      (134999850000 97 9277051       127       147
interp        196418                         504       384
queens        14200                          272       262
strings       (2177780 100 item-99000:       141       178
```

Substrate on its own values was measured against the two it replaced, the
Substrate on the kernel module's cells (branch `cells`) and the one on
wasm GC objects (`main`'s `next/substrate`), which this tree cannot
rebuild; README.md's plan entry 6 records that comparison: at or ahead of
the cells version on every program, ahead of the GC one on arithmetic,
walking, pairs and calls, and behind it where a program makes and frees
many short-lived pairs and closures, by up to a third on the interpreter.

## Checking and compiling Bend (`bench/bend/compile`)

```
proofs-3200 wasmtime   3.05 s   1325 MB
proofs-3200 v8         2.54 s   1449 MB
proofs-800  wasmtime   0.84 s    395 MB
proofs-800  v8         0.74 s    445 MB
```

The module of 3200 blocks is 70,000 lines and 41,600 definitions; it
builds in about 3 s, where the Bend example on the first compiler, with
GC data, took 12.7 s.

## The same programs in the three languages (`bench/compare`)

```
program  result          base    bend  substrate   bend/ substrate/   (wasmtime)
fib      9227465           46      68        148    1.46       3.19
trees    6553550           69      36        137    0.53       1.98
lists    1252500000       136     108        215    0.80       1.58

program  result          base    bend  substrate   bend/ substrate/   (v8)
fib      9227465           78      89        172    1.13       2.19
trees    6553550          105      71        147    0.68       1.40
lists    1252500000       164     119        205    0.72       1.25
```

Bend's trees and lists run faster than the C-like Lisp's because Bend's
runtime takes nodes from free lists and gives a node a match takes back
or reuses it, where the C-like Lisp's programs call K&R's malloc and free;
on `fib`, calls and a machine word's arithmetic, the C-like Lisp is
ahead, with Bend's recursion on a Nat, a number to the code, close
behind. Substrate pays for each value's owners, the dups and drops of
the lowering, and for checking every `car` and `+`: two to three times
the C-like Lisp with the engine's start taken out.
