# Benchmarks

Measured on an AMD Ryzen 9 9950X with 96 GB of memory, on Linux 6.12, with Node
24.21 (V8 13.6) and clang 21.1.8. C is compiled to Wasm with clang -O2 and runs
on the same V8. A ratio is Substrate's time over C's, so below 1 means
Substrate is faster.

## Small programs

`bench/substrate/run.sh [N]` builds each program in Substrate and in C, and
times whole runs, the best of N (5 here), in ms. A run includes starting Node:
27 ms for an empty Substrate program and 15 ms for an empty C module. "No
inline" is the C compiled with -fno-inline.

| Program  | Substrate | C native | C Wasm | C Wasm, no inline | / native | / C Wasm | / no inline |
| -------- | --------: | -------: | -----: | ----------------: | -------: | -------: | ----------: |
| callback |       451 |       32 |     73 |               380 |    13.88 |     6.16 |        1.19 |
| complex  |        81 |       17 |     32 |                74 |     4.65 |     2.56 |        1.09 |
| errors   |       116 |        6 |     23 |                27 |    20.03 |     4.94 |        4.32 |
| expr     |       132 |       84 |    124 |               124 |     1.56 |     1.06 |        1.06 |
| fib      |       102 |       60 |     55 |                55 |     1.70 |     1.84 |        1.85 |
| hash     |       392 |      258 |    306 |               426 |     1.52 |     1.28 |        0.92 |
| matmul   |        70 |       16 |     48 |                48 |     4.51 |     1.47 |        1.47 |
| nbody    |       213 |      162 |    186 |               187 |     1.32 |     1.14 |        1.14 |
| sieve    |       333 |      289 |    330 |               334 |     1.15 |     1.01 |        1.00 |
| sort     |       639 |      280 |    319 |               314 |     2.28 |     2.00 |        2.04 |
| trees    |       128 |       66 |     94 |               105 |     1.94 |     1.35 |        1.22 |
| vec      |       121 |       65 |     94 |               127 |     1.86 |     1.28 |        0.95 |

The median ratio to C's Wasm is 1.41.

- callback: a sum and a count over 10 million integers, through a closure. In
  C, the closure is a function pointer and a context, and clang inlines the
  calls through it.
- complex: the Mandelbrot set, with complex numbers as structs passed and
  returned by value. clang inlines the small functions on them.
- errors: 10 million calls, a tenth of which fail. Substrate throws an
  exception, which the caller catches; C has no exceptions, so its version
  reports the failure with a flag the caller tests.
- expr: a random tree of expressions, variants in an arena, evaluated by match.
- fib: recursive fib.
- hash: an open-addressing hash table of 64-bit keys that doubles as it fills.
- matmul: a product of 500 by 500 matrices of f64.
- nbody: the Benchmarks Game's n-body, 5 million steps.
- sieve: the primes below 100 million.
- sort: quicksort of 5 million integers, comparing through a function pointer.
- trees: the Benchmarks Game's binary trees.
- vec: a growable array from std/vector, at i32 and at a struct: 10 million items.

## JSON

`bench/json/run.sh [N]` runs std/encoding/json against cJSON, compiled to Wasm
and native, and V8's own JSON, on nativejson-benchmark's files: the best of N
(20 here) runs of each phase inside one run, in ms. parse reads the file, write
writes it back, and indented writes it with indentation. Substrate's write
keeps each number's text from the parse; numbers writes with that text dropped,
so that every number is written from its f64. cJSON always writes numbers from
their f64, with sprintf at 15 digits and again at 17 when 15 do not read back
the same, so its numbers row repeats its write row.

| File              | Phase    | Substrate | cJSON Wasm | cJSON native |   V8 | / cJSON Wasm |
| ----------------- | -------- | --------: | ---------: | -----------: | ---: | -----------: |
| twitter.json      | parse    |      0.79 |       0.82 |         0.78 | 0.48 |         0.96 |
| twitter.json      | write    |      0.70 |       0.72 |         0.65 | 0.48 |         0.98 |
| twitter.json      | numbers  |      0.74 |       0.72 |         0.65 | 0.48 |         1.04 |
| twitter.json      | indented |      0.81 |       0.77 |         0.70 | 0.73 |         1.05 |
| citm_catalog.json | parse    |      1.53 |       1.81 |         1.64 | 1.15 |         0.84 |
| citm_catalog.json | write    |      0.79 |       1.44 |         1.02 | 0.80 |         0.55 |
| citm_catalog.json | numbers  |      1.09 |       1.44 |         1.02 | 0.80 |         0.76 |
| citm_catalog.json | indented |      1.09 |       1.52 |         1.16 | 1.53 |         0.71 |
| canada.json       | parse    |      6.70 |      19.36 |         9.61 | 3.10 |         0.35 |
| canada.json       | write    |      1.18 |      41.34 |        42.66 | 5.77 |         0.03 |
| canada.json       | numbers  |      7.30 |      41.34 |        42.66 | 5.77 |         0.18 |
| canada.json       | indented |      2.16 |      40.92 |        42.46 | 7.84 |         0.05 |

## Crypto

`bench/crypto/run.sh [N]` runs std/crypto against mbedTLS, compiled to Wasm and
native: SHA-256 over 16 MiB, 100,000 HMACs of 100 bytes, and PBKDF2 at 600,000
iterations, the best of N (5 here) inside one run, in ms.

| Phase   | Substrate | mbedTLS Wasm | mbedTLS native | / mbedTLS Wasm |
| ------- | --------: | -----------: | -------------: | -------------: |
| SHA-256 |     46.49 |        33.46 |          25.34 |           1.39 |
| HMAC    |    100.81 |        76.07 |          55.28 |           1.33 |
| PBKDF2  |    264.44 |       333.96 |         249.18 |           0.79 |

## Compression

`nix develop .#silesia -c bench/compress/run.sh [N]` runs std/compress against
zlib, compiled to Wasm and native, on the Silesia corpus and the JSON
benchmark's files, 15 files and 216.5 MB in all: deflate at levels 1, 6 and 9,
and inflate, the best of N (1 here). Speeds are in MB/s, so higher is faster;
the ratio is still of times. Sizes are a percentage of the input.

| Phase     | Substrate | zlib Wasm | zlib native | / zlib Wasm | Substrate size | zlib size |
| --------- | --------: | --------: | ----------: | ----------: | -------------: | --------: |
| deflate 1 |     129.7 |     160.0 |       189.0 |        1.23 |         35.98% |    36.09% |
| deflate 6 |      47.3 |      47.3 |        51.3 |        1.00 |         31.81% |    31.82% |
| deflate 9 |      19.5 |      19.3 |        20.0 |        0.99 |         31.55% |    31.55% |
| inflate   |     735.3 |     541.2 |       617.8 |        0.74 |                |           |

Deflate at level 6, file by file, in MB/s and bytes:

| File              | Substrate | zlib Wasm | zlib native | Substrate size | zlib size |
| ----------------- | --------: | --------: | ----------: | -------------: | --------: |
| dickens           |      25.6 |      26.2 |        28.4 |      3,870,484 | 3,871,628 |
| mozilla           |      47.8 |      42.0 |        45.4 |     19,077,917 | 19,089,118 |
| mr                |      31.7 |      32.3 |        33.9 |      3,675,881 | 3,675,935 |
| nci               |     127.5 |     136.7 |       156.3 |      3,200,152 | 3,200,182 |
| ooffice           |      32.9 |      32.4 |        33.8 |      3,096,325 | 3,097,288 |
| osdb              |      57.3 |      59.8 |        66.2 |      3,693,722 | 3,695,164 |
| reymont           |      27.1 |      28.3 |        30.0 |      1,859,584 | 1,860,865 |
| samba             |      64.2 |      68.8 |        75.8 |      5,448,822 | 5,451,399 |
| sao               |      26.6 |      27.9 |        30.5 |      5,331,767 | 5,331,793 |
| webster           |      42.5 |      44.8 |        48.5 |     12,208,533 | 12,213,941 |
| xml               |      94.1 |      96.6 |       108.6 |        687,583 |   687,991 |
| x-ray             |      40.1 |      41.8 |        47.1 |      6,045,094 | 6,045,111 |
| canada.json       |      34.5 |      36.6 |        39.2 |        599,677 |   599,586 |
| citm_catalog.json |     427.9 |     413.5 |       578.7 |         37,786 |    38,149 |
| twitter.json      |     190.6 |     198.7 |       252.9 |         51,488 |    51,488 |

## Compile times

With no cache, Substrate's compiler compiles itself, 11,180 lines, in 0.235 s,
the median of 7 runs: about 47,600 lines a second. Its sources are
substrate/compiler and substrate/host/fs.sub, counting lines that are neither
blank nor only a comment. The command is the compile step of `make bootstrap`:

    substrate/host/subhost.mjs --grant read . --grant write OUT build/compiler substrate build substrate/compiler/main.sub -o OUT -d .

clang compiles each C library's .c files to Wasm objects, the best of 3. Their
lines are counted the same way, without the headers they include, so clang's
true rate is somewhat higher.

| Library                         | Lines |    -O2 | Lines/s |    -O0 | Lines/s |
| ------------------------------- | ----: | -----: | ------: | -----: | ------: |
| zlib (deflate and inflate)      | 4,677 | 514 ms |   9,100 | 173 ms |  27,000 |
| mbedTLS (SHA-256, HMAC, PBKDF2) | 2,341 | 164 ms |  14,300 | 102 ms |  23,000 |
| cJSON                           | 2,518 | 152 ms |  16,600 |  39 ms |  64,600 |

Each benchmark built from scratch, the best of 3, in ms: Substrate's
`substrate build` with no cache, and with only its core library cached, against
clang -O2 as the benchmarks' scripts run it. Each small program takes about
0.11 s with the core library cached, from 2 lines (fib) to 56 (nbody), and
`substrate version`, which builds nothing, takes 44 ms: fixed costs are most of
a small program's build.

| Benchmark | Substrate, no cache | Substrate, core cached | clang -O2 |
| --------- | ------------------: | ---------------------: | --------: |
| callback  |                 137 |                    111 |        38 |
| complex   |                 137 |                    115 |        26 |
| errors    |                 135 |                    110 |        26 |
| expr      |                 136 |                    117 |        41 |
| fib       |                 134 |                    110 |        24 |
| hash      |                 138 |                    111 |        44 |
| matmul    |                 131 |                    110 |        35 |
| nbody     |                 136 |                    119 |        38 |
| sieve     |                 134 |                    116 |        37 |
| sort      |                 136 |                    111 |        38 |
| trees     |                 135 |                    116 |        39 |
| vec       |                 135 |                    114 |        43 |
| json      |                 202 |                        |       180 |
| crypto    |                 143 |                        |       195 |
| compress  |                 156 |                        |       555 |

## The compiler

`bench/compiler/run.sh [N]` times the compiler compiling itself with no cache,
the best and median of N runs (5 here), and gives the size of its Wasm: pruned,
as builds write it, and stripped of names. bend2's `bench/compile/run.sh [N]
[RUNS]` times checking and compiling a generated Bend module of N proofs (3200),
from a cache that holds bend2's own modules.

| Build                  | Best    | Median  |
| ---------------------- | ------: | ------: |
| The compiler           |  245 ms |  250 ms |
| bend2, 3200 proofs     |  2.59 s |  2.59 s |

The compiler is 606.9 KiB of Wasm in 21 modules, and 432.0 KiB stripped.
