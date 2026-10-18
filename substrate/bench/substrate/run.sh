#!/usr/bin/env bash
# Substrate against the same programs in C, native and wasm (with and without inlining), the
# wasm on V8.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/substrate"
n="${1:-3}"
shift || true
names=("$@")
[ ${#names[@]} -gt 0 ] || names=($(cd "$here" && ls *.sub | sed 's/\.sub$//'))
mkdir -p "$out"

for name in "${names[@]}"; do
  (cd "$here" && "$root/bin/sub" build "$name.sub" -o "$out/$name" -c "$root/build/bench/cache" > /dev/null)
  # nix's clang wrapper adds hardening flags that slow C down, warns of the wasm target, and
  # passes native link flags, so wasm-ld links the wasm itself.
  NIX_HARDENING_ENABLE= clang -O2 -o "$out/$name.native" "$here/$name.c"
  for v in wasm noinline; do
    NIX_HARDENING_ENABLE= clang --target=wasm32 -O2 $([ $v = noinline ] && echo -fno-inline) -ffreestanding -nostdlib \
      -mbulk-memory -c -o "$out/$name.$v.o" "$here/$name.c" 2> "$out/$name.wasm.log" &&
      wasm-ld --no-entry -o "$out/$name.$v.wasm" "$out/$name.$v.o" 2>> "$out/$name.wasm.log" ||
      { cat "$out/$name.wasm.log"; exit 1; }
  done
done

variants=(ours native wasm noinline)
node=(node --stack-size=4000 --experimental-wasm-exnref --no-liftoff)
# The C wasm exports run, whose result it prints.
c_wasm='const fs = require("fs");
console.log(String(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(process.argv[1]))).exports.run()))'

declare -A best result
run() {
  local start=$EPOCHREALTIME
  local line
  case $1 in
    ours) line="$("${node[@]}" "$root/host/subhost.mjs" "$out/$2" 2>/dev/null | head -1)" ;;
    native) line="$("$out/$2.native" 2>/dev/null | head -1)" ;;
    wasm | noinline) line="$("${node[@]}" -e "$c_wasm" "$out/$2.$1.wasm" 2>/dev/null | head -1)" ;;
  esac
  local end=$EPOCHREALTIME
  local us=$(( ${end/./} - ${start/./} ))
  result[$1.$2]="$line"
  if [ -z "${best[$1.$2]:-}" ] || [ "$us" -lt "${best[$1.$2]}" ]; then best[$1.$2]=$us; fi
}

for ((i = 0; i < n; i++)); do
  for name in "${names[@]}"; do
    for v in "${variants[@]}"; do run "$v" "$name"; done
  done
done

printf "%-9s %-20s %7s %7s %7s %9s %8s %8s %11s\n" benchmark result ours native "c wasm" "no inline" "/native" "/c wasm" "/no inline"
for name in "${names[@]}"; do
  r="${result[ours.$name]}"
  [ "$r" = "${result[native.$name]}" ] && [ "$r" = "${result[wasm.$name]}" ] && [ "$r" = "${result[noinline.$name]}" ] ||
    r="DIFFERS: ${result[ours.$name]} ${result[native.$name]} ${result[wasm.$name]} ${result[noinline.$name]}"
  awk -v name="$name" -v r="$r" -v o="${best[ours.$name]}" -v c="${best[native.$name]}" -v w="${best[wasm.$name]}" -v i="${best[noinline.$name]}" \
    'BEGIN { printf "%-9s %-20s %7.0f %7.0f %7.0f %9.0f %8.2f %8.2f %11.2f\n", name, r, o / 1000, c / 1000, w / 1000, i / 1000, o / c, o / w, o / i }'
done
