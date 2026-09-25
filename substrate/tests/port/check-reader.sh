#!/usr/bin/env bash
# Lifecycle: test harness for the compiler port.
#
# Compare compiler/reader.sub with stage0's reader on every .sub file in the
# repository: each writes what it reads (subc read, tests/port/read-dump.sub),
# and the two must be the same.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
out=build/port
mkdir -p "$out"
bin/subc build tests/port/read-dump.sub -o "$out/read-dump" || exit 1
same=0
differ=0
for f in $(git ls-files '*.sub'); do
  bin/subc read "$f" > "$out/stage0.txt" 2>&1
  build/subhost "$out/read-dump" "$f" > "$out/port.txt" 2>&1
  if cmp -s "$out/stage0.txt" "$out/port.txt"; then
    same=$((same + 1))
  else
    differ=$((differ + 1))
    echo "DIFFERS $f"
    diff "$out/stage0.txt" "$out/port.txt" | head -6
  fi
done
echo "$same the same, $differ different"
[ $differ -eq 0 ]
