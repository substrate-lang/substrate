# substrate

A thin Lisp over WebAssembly whose main addition to wasm is compile-time
execution. Macros are kernel code, compiled to wasm and run by the same
engine that runs the program. The hope is that different languages can be
built as libraries over one small kernel.

`docs/spec.md` fixes what the bootstrap must preserve: the value and memory
layout, the unit of compilation, the host interface, and the macro API.

## Layout

- `docs/spec.md`: the kernel specification (v0 draft).
- `host/`: the host, in C over the wasmtime C API. It owns stores and
  provides the `host` imports, including the instantiate hook.
- `rt/rt.sub`: the runtime (allocator, pairs, symbols, syntax objects,
  printer), written in the kernel language.
- `stage0/`: the stage0 compiler in Chez Scheme: reader, expander,
  compiler, wasm encoder, FFI.
- `tests/`: `.sub` programs, with `.out` (expected output) or `.err`
  (expected error) files.

## Use

Everything runs in the flake's dev shell:

```sh
nix develop
make check                      # build the host library, run the tests
bin/subc run tests/macros.sub   # compile and run a program's main
bin/subc expand FILE            # print fully expanded kernel forms
bin/subc compile FILE -o OUT    # write the phase-0 wasm module
bin/subc rt -o build/rt.wasm    # write the compiled runtime
wasm-tools print OUT            # inspect a module
```

## Status

Stage0 goes from source to a running program. The steps are reader,
expander, kernel compiler and binary wasm, then running under wasmtime.
`define-syntax` works end to end: transformers are compiled into chunks,
instantiated through the host in the compile-time store, and called
through the shared table. Static compile-time values, `syntax-local-value`,
`syntax-error` and `free-identifier=?` work too.

Next: hygiene (introduction and use-site scopes), then modules and phases.
See `docs/spec.md` section 7.
