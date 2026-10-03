#!/usr/bin/env bash
# Lifecycle: benchmark. Writes proofs-N.sub, a Bend module of N blocks of
# proofs by induction and rewriting, modelled on Bend2's proofs_N
# benchmark: the prelude (header.sub), then blocks k = 0 .. N-1, cycling
# through a Nat block (nat.sub), a list block (list.sub) and a tree block
# (tree.sub), each with k substituted for @. Building the module checks
# and compiles every block, which is what bench/bend/compile/run.sh
# times.
#
#   bench/bend/compile/proofs.sh N > proofs-N.sub
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
n="${1:-3200}"
grep -v '^;; Lifecycle' "$here/header.sub" | sed '1{/^;;/d;}'
echo
kinds=(nat list tree)
for ((k = 0; k < n; k++)); do
  grep -v '^;; Lifecycle' "$here/${kinds[k % 3]}.sub" | sed "s/@/$k/g"
  echo
done
# The host runs main: nothing, once the module is checked and compiled.
echo "(func (main))"
