#!/usr/bin/env bash
# lib/compress against zlib, as wasm on V8 and native, on the Silesia corpus and the JSON benchmark's files: deflate at
# levels 1, 6 and 9, inflate, and round trips through both. In the flake's silesia shell:
# nix develop .#silesia -c bench/compress/run.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/compress"
reps="${1:-1}"
mkdir -p "$out/zlib"

(cd "$here" && "$root/bin/sub" build compress.sub -o "$out/ours" -c "$root/build/bench/cache" > /dev/null)
[ -f "$out/zlib/zlib.h" ] || tar -xzf "$ZLIB_SOURCE" -C "$out/zlib" --strip-components=1
sources=("$out"/zlib/{adler32,crc32,deflate,inffast,inflate,inftrees,trees,zutil}.c)
flags=(-O2 -I"$out/zlib")
NIX_HARDENING_ENABLE= clang "${flags[@]}" -o "$out/zlib.native" "$here/zlib.c" "${sources[@]}"
NIX_HARDENING_ENABLE= wasm32-unknown-wasi-clang "${flags[@]}" -o "$out/zlib.wasm" "$here/zlib.c" "${sources[@]}"

node --experimental-wasm-exnref --no-liftoff --no-warnings "$here/run.mjs" "$out" "$reps" "$SILESIA"/* \
  "$JSON_BENCH_FILES"/*
