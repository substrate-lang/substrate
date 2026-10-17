#!/usr/bin/env bash
# The same programs in the C-like Lisp, Bend and Substrate, timed (ENGINE=v8 for V8).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/compare"
n="${1:-3}"
shift || true
names=("$@")
[ ${#names[@]} -gt 0 ] || names=(fib trees lists)
langs=(base bend substrate)
mkdir -p "$out"
for name in "${names[@]}"; do
  for lang in "${langs[@]}"; do
    (cd "$here/$name" && "$root/bin/sub" build "$lang.sub" -o "$out/$name-$lang" -c "$root/build/bench/cache" > /dev/null)
  done
done

node=(node --stack-size=4000 --experimental-wasm-exnref --no-liftoff "$root/host/subhost.mjs")
declare -A best result
run() { # name lang
  local start=$EPOCHREALTIME line end us
  case ${ENGINE:-wasmtime} in
    v8) line="$("${node[@]}" "$out/$1-$2" 2>/dev/null | head -1)" ;;
    *) line="$("$root/build/subhost" "$out/$1-$2" 2>/dev/null | head -1)" ;;
  esac
  end=$EPOCHREALTIME
  us=$(( ${end/./} - ${start/./} ))
  result[$1.$2]="$line"
  if [ -z "${best[$1.$2]:-}" ] || [ "$us" -lt "${best[$1.$2]}" ]; then best[$1.$2]=$us; fi
}
for ((i = 0; i < n; i++)); do
  for name in "${names[@]}"; do for lang in "${langs[@]}"; do run "$name" "$lang"; done; done
done
printf "%-8s %-12s %7s %7s %10s %7s %10s   (%s)\n" program result base bend substrate "bend/" "substrate/" "${ENGINE:-wasmtime}"
for name in "${names[@]}"; do
  r="${result[$name.base]}"
  [ "$r" = "${result[$name.bend]}" ] && [ "$r" = "${result[$name.substrate]}" ] ||
    r="DIFFERS: ${result[$name.base]} ${result[$name.bend]} ${result[$name.substrate]}"
  awk -v name="$name" -v r="$r" -v c="${best[$name.base]}" -v b="${best[$name.bend]}" -v s="${best[$name.substrate]}" \
    'BEGIN { printf "%-8s %-12s %7.0f %7.0f %10.0f %7.2f %10.2f\n", name, substr(r, 1, 12), c / 1000, b / 1000, s / 1000, b / c, s / c }'
done
