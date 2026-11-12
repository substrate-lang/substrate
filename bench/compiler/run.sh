#!/usr/bin/env bash
# The compiler compiling itself without a cache: the best and median of N runs (5 by default), in ms. Then the size of
# its Wasm, pruned as builds write it, and again stripped of names.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/compiler"
n="${1:-5}"
mkdir -p "$out"
: > "$out/empty.sub"
"$root/bin/substrate" expand "$out/empty.sub" > /dev/null

compiled() {
  rm -rf "${out:?}/$1"
  (cd "$root" && substrate/host/subhost.mjs --grant read . --grant write "$out/$1" build/compiler \
     substrate build substrate/compiler/main.sub -o "$out/$1" -d . "${@:2}" > /dev/null)
}

ms=()
for ((i = 0; i < n; i++)); do
  start=$EPOCHREALTIME
  compiled self
  end=$EPOCHREALTIME
  ms+=($(( (${end/./} - ${start/./}) / 1000 )))
done
compiled stripped -s
sorted=($(printf '%s\n' "${ms[@]}" | sort -n))
kib() { cat "$out/$1"/*.wasm | wc -c | awk '{ printf "%.1f", $1 / 1024 }'; }
printf "self-compile: best %d ms, median %d ms, of %d\n" "${sorted[0]}" "${sorted[$((n / 2))]}" "$n"
printf "compiler: %s KiB of Wasm, %s KiB stripped, in %d modules\n" "$(kib self)" "$(kib stripped)" \
  "$(ls "$out/self"/*.wasm | wc -l)"
