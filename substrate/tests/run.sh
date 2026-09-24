#!/usr/bin/env bash
# Run every tests/*.sub.
#   NAME.out    expected output of a successful run
#   NAME.err    a line that must appear in the output of a failing run
#   NAME.links  the instance names the compiled module may import from,
#               one per line (checks that modules link only what they use)
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
mkdir -p build/tests

# Build the syntax library once first, so library compile notices stay out
# of test output.
bin/subc syntax-library -o build/syntax.wasm > /dev/null
wasm-tools validate build/syntax.wasm || { echo "FAIL syntax.wasm does not validate"; exit 1; }

pass=0
fail=0
for t in tests/*.sub; do
  name="$(basename "$t" .sub)"
  actual="$(cd tests && ../bin/subc run "$name.sub" 2>&1)"
  code=$?
  problem=""
  if [ -f "tests/$name.out" ]; then
    if [ $code -ne 0 ] || [ "$actual" != "$(cat "tests/$name.out")" ]; then
      problem="output differs (exit $code)"
    elif ! (cd tests && ../bin/subc compile "$name.sub" -o "../build/tests/$name.wasm" > /dev/null) ||
         ! wasm-tools validate "build/tests/$name.wasm"; then
      problem="compiled module does not validate"
    elif [ -f "tests/$name.links" ]; then
      links="$(wasm-tools print "build/tests/$name.wasm" | sed -n 's/^ *(import "\([^"]*\)".*/\1/p' | sort -u)"
      if [ "$links" != "$(sort -u "tests/$name.links")" ]; then
        problem="imports from: $(echo $links), expected: $(echo $(cat "tests/$name.links"))"
      fi
    fi
  elif [ -f "tests/$name.err" ]; then
    if [ $code -eq 0 ] || ! grep -qF -- "$(cat "tests/$name.err")" <<< "$actual"; then
      problem="expected an error containing: $(cat "tests/$name.err")"
    fi
  else
    problem="no .out or .err file"
  fi
  if [ -z "$problem" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL $name: $problem"
    if [ -f "tests/$name.out" ]; then diff <(echo "$actual") "tests/$name.out" | head -20; else echo "$actual" | head -10; fi
  fi
done
echo "$pass passed, $fail failed"
[ $fail -eq 0 ]
