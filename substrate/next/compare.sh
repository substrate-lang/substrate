#!/usr/bin/env bash
# Lifecycle: experimental. The new compiler (next/sub) against the
# compiler (bin/sub): each .sub file of the repository expanded by both,
# which must print the same, its fully expanded code or its error. A file
# that needs what the new compiler does not do yet, which it says, is
# counted apart. Prints each file that differs, then the counts. In the
# dev shell:
#
#   next/compare.sh [FILE ...]
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/build/next/compare"
mkdir -p "$out"
cd "$root"
files=("$@")
[ ${#files[@]} -gt 0 ] || files=($(find compiler lib examples tests -name '*.sub' | sort))

same=0
later=0
differ=0
for f in "${files[@]}"; do
  n="${f//\//_}"
  bin/sub expand "$f" > "$out/$n.old" 2>&1
  HOST=build/subhost next/sub expand "$f" > "$out/$n.new" 2>&1
  if cmp -s "$out/$n.old" "$out/$n.new"; then
    same=$((same + 1))
  elif grep -q "not yet in the new compiler" "$out/$n.new"; then
    later=$((later + 1))
  else
    differ=$((differ + 1))
    echo "differs: $f"
  fi
done
echo "$same the same, $later needing what comes later, $differ different"
