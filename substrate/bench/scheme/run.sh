#!/usr/bin/env bash
# Scheme's benchmarks, timed on wasmtime and on V8.
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
run() { # engine name
  local start=$EPOCHREALTIME line end us
  case $1 in
    wasmtime) line="$("$root/build/subhost" "$out/$2" 2>/dev/null | head -1)" ;;
    v8) line="$("${node[@]}" "$out/$2" 2>/dev/null | head -1)" ;;
  esac
  end=$EPOCHREALTIME
  us=$(( ${end/./} - ${start/./} ))
  result[$1.$2]="$line"
  if [ -z "${best[$1.$2]:-}" ] || [ "$us" -lt "${best[$1.$2]}" ]; then best[$1.$2]=$us; fi
}
for ((i = 0; i < n; i++)); do
  for name in "${names[@]}"; do run wasmtime "$name"; run v8 "$name"; done
done
printf "%-13s %-24s %9s %9s\n" benchmark result wasmtime v8
for name in "${names[@]}"; do
  r="${result[wasmtime.$name]}"
  [ "$r" = "${result[v8.$name]}" ] || r="DIFFERS: $r / ${result[v8.$name]}"
  awk -v name="$name" -v r="$r" -v w="${best[wasmtime.$name]}" -v v="${best[v8.$name]}" \
    'BEGIN { printf "%-13s %-24s %9.0f %9.0f\n", name, substr(r, 1, 24), w / 1000, v / 1000 }'
done
