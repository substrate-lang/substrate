#!/usr/bin/env bash
# Lifecycle: benchmark. Checking and compiling Bend: proofs-N.sub, N
# blocks of proofs (proofs.sh, default 3200, after Bend2's proofs_3200),
# built with bin/sub on wasmtime and on V8, Bend's own modules already in
# the cache (warm.sub), so the time is the proofs module's: its wall
# time and the compiler's maximum resident size, in MB. In the dev
# shell:
#
#   bench/bend/compile/run.sh [N]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
n="${1:-3200}"
out="$root/build/bench/bend"
mkdir -p "$out"
"$here/proofs.sh" "$n" > "$here/proofs-$n.sub"
# A V8 host for the compiler: node with the flags the compiler's wasm needs.
printf '#!/bin/sh\nexec node --stack-size=4000 --experimental-wasm-exnref "%s/host/subhost.mjs" "$@"\n' "$root" > "$out/v8"
chmod +x "$out/v8"
case "$(uname)" in Darwin) rss=(-l); rssline="maximum resident set size";; *) rss=(-v); rssline="Maximum resident set size";; esac
for engine in wasmtime v8; do
  case $engine in wasmtime) host="";; v8) host="build/bench/bend/v8";; esac
  cache="$out/cache-$engine"
  mkdir -p "$cache"
  (cd "$here" && HOST=$host "$root/bin/sub" build warm.sub -o "$out/warm-$engine" -c "$cache" > /dev/null)
  rm -rf "$out/proofs-$n-$engine"
  log="$out/time-$engine.log"
  (cd "$here" && HOST=$host /usr/bin/time "${rss[@]}" "$root/bin/sub" build "proofs-$n.sub" -o "$out/proofs-$n-$engine" -c "$cache" > "$log" 2>&1) || { cat "$log"; exit 1; }
  real="$(grep -E '^\s*real|real ' "$log" | head -1 | awk '{print $1 ~ /real/ ? $2 : $1}')"
  bytes="$(grep "$rssline" "$log" | awk '{print $1 ~ /[0-9]/ ? $1 : $NF}')"
  case "$(uname)" in Darwin) mb=$(( bytes / 1048576 ));; *) mb=$(( bytes / 1024 ));; esac
  printf "proofs-%s %-8s %6s s  %5s MB\n" "$n" "$engine" "$real" "$mb"
done
