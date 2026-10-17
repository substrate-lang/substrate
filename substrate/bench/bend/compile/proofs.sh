#!/usr/bin/env bash
# Writes a Bend module: header.sub, then N blocks of nat.sub, list.sub and tree.sub, @ = k.
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
echo "(func (main))"
