#!/usr/bin/env bash
# Lifecycle: benchmark. The C-like Lisp against C. Each NAME.sub is built
# with bin/sub and run on build/subhost (wasmtime). NAME.c, the same
# program in C, is built with clang -O2 three ways: natively, for wasm
# (run by the wasmtime CLI), and for wasm without inlining, since our
# compiler does not inline C functions. All versions allocate with K&R's
# malloc (bench.h) and must print the same result. Prints each
# benchmark's result, the least time of N runs (default 3) of each
# version in ms, run interleaved, and the ratios of ours to the others.
# In the dev shell:
#
#   bench/base/run.sh [N [NAME ...]]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/base"
n="${1:-3}"
shift || true
names=("$@")
[ ${#names[@]} -gt 0 ] || names=($(cd "$here" && ls *.sub | sed 's/\.sub$//'))
mkdir -p "$out"

for name in "${names[@]}"; do
  (cd "$here" && "$root/bin/sub" build "$name.sub" -o "$out/$name" -c "$root/build/bench/cache" > /dev/null)
  # The shell's clang is nix's wrapper, whose hardening flags, on by
  # default, are not clang's defaults and slow C down, and which warns of
  # the wasm target: its messages are kept, and shown if it fails.
  NIX_HARDENING_ENABLE= clang -O2 -o "$out/$name.native" "$here/$name.c"
  NIX_HARDENING_ENABLE= clang --target=wasm32 -O2 -ffreestanding -nostdlib -mbulk-memory -Wl,--no-entry \
    -o "$out/$name.wasm" "$here/$name.c" 2> "$out/$name.wasm.log" || { cat "$out/$name.wasm.log"; exit 1; }
  NIX_HARDENING_ENABLE= clang --target=wasm32 -O2 -fno-inline -ffreestanding -nostdlib -mbulk-memory -Wl,--no-entry \
    -o "$out/$name.noinline.wasm" "$here/$name.c" 2> "$out/$name.wasm.log" || { cat "$out/$name.wasm.log"; exit 1; }
done

variants=(ours native wasm noinline)
command_of() {
  case $1 in
    ours) echo "$root/build/subhost $out/$2" ;;
    native) echo "$out/$2.native" ;;
    wasm) echo "wasmtime run --invoke run $out/$2.wasm" ;;
    noinline) echo "wasmtime run --invoke run $out/$2.noinline.wasm" ;;
  esac
}

# Variant $1 of benchmark $2, run once: its time, in best if it is the
# least yet, and its first line of output, in result.
declare -A best result
run() {
  local start=$EPOCHREALTIME
  local line
  line="$($(command_of "$1" "$2") 2>/dev/null | head -1)"
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
