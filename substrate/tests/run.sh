#!/usr/bin/env bash
# Lifecycle: test harness.
#
# Run every tests/*.sub and examples/*.sub. Next to each file:
#   NAME.out    expected output of a successful run
#   NAME.err    a line that must appear in the output of a failing run
#   NAME.links  the instance names the compiled phase-0 part may import
#               from, one per line (checks that programs link only what they
#               use)
set -uo pipefail
shopt -s nullglob
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Build the syntax library once first, so library compile notices stay out
# of test output.
mkdir -p build
bin/subc syntax-library -o build/syntax.wasm > /dev/null
wasm-tools validate build/syntax.wasm || { echo "FAIL syntax.wasm does not validate"; exit 1; }

pass=0
fail=0
for t in tests/*.sub examples/*.sub; do
  dir="$(dirname "$t")"
  name="$(basename "$t" .sub)"
  base="$dir/$name"
  out="build/$dir"
  mkdir -p "$out"
  actual="$(cd "$dir" && "$root/bin/subc" run "$name.sub" 2>&1)"
  code=$?
  problem=""
  if [ -f "$base.out" ]; then
    if [ $code -ne 0 ] || [ "$actual" != "$(cat "$base.out")" ]; then
      problem="output differs (exit $code)"
    elif ! (cd "$dir" && "$root/bin/subc" compile "$name.sub" -o "$root/$out/$name.wasm" > /dev/null) ||
         ! for part in "$out/$name.wasm" "$out/$name".phase*.wasm; do
             wasm-tools validate "$part" || exit 1; done; then
      problem="a compiled part does not validate"
    elif [ -f "$base.links" ]; then
      links="$(wasm-tools print "$out/$name.wasm" | sed -n 's/^ *(import "\([^"]*\)".*/\1/p' | sort -u)"
      if [ "$links" != "$(sort -u "$base.links")" ]; then
        problem="imports from: $(echo $links), expected: $(echo $(cat "$base.links"))"
      fi
    fi
  elif [ -f "$base.err" ]; then
    if [ $code -eq 0 ] || ! grep -qF -- "$(cat "$base.err")" <<< "$actual"; then
      problem="expected an error containing: $(cat "$base.err")"
    fi
  else
    problem="no .out or .err file"
  fi
  if [ -z "$problem" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL $base: $problem"
    if [ -f "$base.out" ]; then diff <(echo "$actual") "$base.out" | head -20; else echo "$actual" | head -10; fi
  fi
done
echo "$pass passed, $fail failed"
[ $fail -eq 0 ]
