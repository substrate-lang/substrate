#!/usr/bin/env bash
# Lifecycle: benchmark. Writes proofs-N.sub, a Bend module of N blocks of
# proofs by induction and rewriting after Bend2's proofs_N benchmark: the
# prelude (header.sub), then block k, for k from 0 below N, a Nat's
# (nat.sub), a list's (list.sub) or a tree's (tree.sub) in turn, with k
# for @. Every block is checked and compiled when the module is built,
# which is what bench/bend/compile/run.sh times.
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
