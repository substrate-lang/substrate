#!/usr/bin/env bash
# std/crypto against mbedTLS, as wasm on V8 and native: SHA-256, HMAC and PBKDF2.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/crypto"
reps="${1:-5}"
mkdir -p "$out"

(cd "$here" && "$root/bin/substrate" build crypto.sub -o "$out/ours" -c "$root/build/bench/cache" > /dev/null)
sources=("$MBEDTLS_SOURCE"/library/{sha256,md,pkcs5,platform_util,constant_time}.c)
flags=(-O2 -I"$here" -I"$MBEDTLS_SOURCE/include" -I"$MBEDTLS_SOURCE/library" -DMBEDTLS_CONFIG_FILE='"config.h"')
NIX_HARDENING_ENABLE= clang "${flags[@]}" -o "$out/mbedtls.native" "$here/mbedtls.c" "${sources[@]}"
NIX_HARDENING_ENABLE= wasm32-unknown-wasi-clang "${flags[@]}" -o "$out/mbedtls.wasm" "$here/mbedtls.c" "${sources[@]}"

node --experimental-wasm-exnref --no-liftoff --no-warnings "$here/run.mjs" "$out" "$reps"
