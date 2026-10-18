#!/usr/bin/env bash
# Times checking and compiling the module proofs.sh writes, on wasmtime and on V8.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
n="${1:-3200}"
out="$root/build/bench/bend"
mkdir -p "$out"
# In build/, at this directory's depth, so the requires copied from header.sub resolve.
"$here/proofs.sh" "$n" > "$out/proofs-$n.sub"
printf '#!/bin/sh\nexec node --stack-size=4000 --experimental-wasm-exnref "%s/host/subhost.mjs" "$@"\n' "$root" > "$out/v8"
chmod +x "$out/v8"
for engine in wasmtime v8; do
  case $engine in wasmtime) host="";; v8) host="build/bench/bend/v8";; esac
  cache="$out/cache-$engine"
  mkdir -p "$cache"
  (cd "$here" && HOST=$host "$root/bin/sub" build warm.sub -o "$out/warm-$engine" -c "$cache" > /dev/null)
  rm -rf "$out/proofs-$n-$engine"
  log="$out/time-$engine.log"
  (cd "$out" && HOST=$host command time -f '%e %M' "$root/bin/sub" build "proofs-$n.sub" -o "$out/proofs-$n-$engine" -c "$cache" > "$log" 2>&1) || { cat "$log"; exit 1; }
  read -r real kb < <(tail -1 "$log")
  printf "proofs-%s %-8s %6s s  %5s MB\n" "$n" "$engine" "$real" "$((kb / 1024))"
done
