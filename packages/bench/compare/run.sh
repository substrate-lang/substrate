#!/usr/bin/env bash
# The same programs in Substrate, Bend and Scheme, timed on V8.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
out="$root/build/bench/compare"
n="${1:-3}"
shift || true
names=("$@")
[ ${#names[@]} -gt 0 ] || names=(fib trees lists)
langs=(substrate bend scheme)
mkdir -p "$out"
for name in "${names[@]}"; do
  for lang in "${langs[@]}"; do
    (cd "$here/$name" && "$root/bin/substrate" build "$lang.sub" -o "$out/$name-$lang" -c "$root/build/bench/cache" > /dev/null)
  done
done

node=(node --stack-size=4000 --experimental-wasm-exnref --no-liftoff "$root/substrate/host/subhost.mjs")
declare -A best result
run() { # name lang
  local start=$EPOCHREALTIME line end us
  line="$("${node[@]}" "$out/$1-$2" 2>/dev/null | head -1)"
  end=$EPOCHREALTIME
  us=$(( ${end/./} - ${start/./} ))
  result[$1.$2]="$line"
  if [ -z "${best[$1.$2]:-}" ] || [ "$us" -lt "${best[$1.$2]}" ]; then best[$1.$2]=$us; fi
}
for ((i = 0; i < n; i++)); do
  for name in "${names[@]}"; do for lang in "${langs[@]}"; do run "$name" "$lang"; done; done
done
printf "%-8s %-12s %10s %7s %10s %7s %10s\n" program result substrate bend scheme "bend/" "scheme/"
for name in "${names[@]}"; do
  r="${result[$name.substrate]}"
  [ "$r" = "${result[$name.bend]}" ] && [ "$r" = "${result[$name.scheme]}" ] ||
    r="DIFFERS: ${result[$name.substrate]} ${result[$name.bend]} ${result[$name.scheme]}"
  awk -v name="$name" -v r="$r" -v substrate="${best[$name.substrate]}" -v bend="${best[$name.bend]}" -v scheme="${best[$name.scheme]}" \
    'BEGIN { printf "%-8s %-12s %10.0f %7.0f %10.0f %7.2f %10.2f\n", name, substr(r, 1, 12), substrate / 1000, bend / 1000, scheme / 1000, bend / substrate, scheme / substrate }'
done
