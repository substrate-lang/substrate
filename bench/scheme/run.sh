#!/usr/bin/env bash
# Scheme's benchmarks, timed on V8.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/scheme"
n="${1:-3}"
shift || true
names=("$@")
[ ${#names[@]} -gt 0 ] || names=(big-arith big-traverse big-conses big-calls lists closures interp queens strings)
mkdir -p "$out"
for name in "${names[@]}"; do
  (cd "$here" && "$root/bin/sub" build "$name.sub" -o "$out/$name" -c "$root/build/bench/cache" > /dev/null)
done

node=(node --stack-size=4000 --experimental-wasm-exnref --no-liftoff "$root/host/subhost.mjs")
declare -A best result
run() { # name
  local start=$EPOCHREALTIME line end us
  line="$("${node[@]}" "$out/$1" 2>/dev/null | head -1)"
  end=$EPOCHREALTIME
  us=$(( ${end/./} - ${start/./} ))
  result[$1]="$line"
  if [ -z "${best[$1]:-}" ] || [ "$us" -lt "${best[$1]}" ]; then best[$1]=$us; fi
}
for ((i = 0; i < n; i++)); do
  for name in "${names[@]}"; do run "$name"; done
done
printf "%-13s %-24s %9s\n" benchmark result ms
for name in "${names[@]}"; do
  awk -v name="$name" -v r="${result[$name]}" -v t="${best[$name]}" \
    'BEGIN { printf "%-13s %-24s %9.0f\n", name, substr(r, 1, 24), t / 1000 }'
done
