#!/usr/bin/env bash
# std/encoding/json.sub against cJSON, as wasm on V8 and native, and V8's own JSON, on nativejson-benchmark's files.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/json"
reps="${1:-20}"
mkdir -p "$out/data"
install -m 644 "$JSON_BENCH_FILES"/*.json "$out/data"

(cd "$here" && "$root/bin/substrate" build json.sub -o "$out/ours" -c "$root/build/bench/cache" > /dev/null)
NIX_HARDENING_ENABLE= clang -O2 -I"$CJSON_SOURCE" -o "$out/cjson.native" "$here/cjson.c" -lm
NIX_HARDENING_ENABLE= wasm32-unknown-wasi-clang -O2 -I"$CJSON_SOURCE" -o "$out/cjson.wasm" "$here/cjson.c"

node --stack-size=4000 --experimental-wasm-exnref --no-liftoff --no-warnings "$here/run.mjs" "$out" "$reps" \
  "$out/data/twitter.json" "$out/data/citm_catalog.json" "$out/data/canada.json"
