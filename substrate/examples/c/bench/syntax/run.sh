#!/usr/bin/env bash
# Lifecycle: benchmark. Scope changes by the kernel and by the C example's
# syntax objects (scopes.sub), on wasmtime (build/subhost) and on V8
# (host/subhost.mjs): the least time of N runs (default 5) of each mode,
# interleaved, and each pass's time, less the time to read the file, and
# for the C example's to convert it too. In the dev shell:
#
#   examples/c/bench/syntax/run.sh [N]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="$root/build/bench/syntax"
n="${1:-5}"
mkdir -p "$out"
(cd "$here" && "$root/bin/sub" build scopes.sub -o "$out/scopes" > /dev/null)
cd "$root"

declare -A best
for ((i = 0; i < n; i++)); do
  for host in wasmtime v8; do
    for m in 0 1 2 3; do
      start=$EPOCHREALTIME
      if [ $host = wasmtime ]; then build/subhost "$out/scopes" $m > /dev/null; else node host/subhost.mjs "$out/scopes" $m > /dev/null; fi
      end=$EPOCHREALTIME
      us=$(( ${end/./} - ${start/./} ))
      if [ -z "${best[$host.$m]:-}" ] || [ "$us" -lt "${best[$host.$m]}" ]; then best[$host.$m]=$us; fi
    done
  done
done

printf "%-9s %8s %9s %11s %9s\n" host read convert "kernel/pass" "ours/pass"
for host in wasmtime v8; do
  awk -v h=$host -v r="${best[$host.0]}" -v c="${best[$host.1]}" -v k="${best[$host.2]}" -v o="${best[$host.3]}" \
    'BEGIN { printf "%-9s %6.0fms %7.1fms %9.1fms %7.1fms\n", h, r / 1000, (c - r) / 1000, (k - r) / 10000, (o - c) / 10000 }'
done
