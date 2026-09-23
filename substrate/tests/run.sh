#!/usr/bin/env bash
# Run every tests/*.sub. NAME.out: expected output of a successful run.
# NAME.err: a line that must appear in the output of a failing run.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
mkdir -p build/tests

# Build rt once first so library compile notices stay out of test output.
bin/subc rt -o build/rt.wasm > /dev/null
wasm-tools validate build/rt.wasm || { echo "FAIL rt.wasm does not validate"; exit 1; }

pass=0
fail=0
for t in tests/*.sub; do
  name="$(basename "$t" .sub)"
  actual="$(cd tests && ../bin/subc run "$name.sub" 2>&1)"
  code=$?
  if [ -f "tests/$name.out" ]; then
    if [ $code -eq 0 ] && [ "$actual" == "$(cat "tests/$name.out")" ] &&
       bin/subc compile "$t" -o "build/tests/$name.wasm" > /dev/null && wasm-tools validate "build/tests/$name.wasm"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      echo "FAIL $name (exit $code)"
      diff <(echo "$actual") "tests/$name.out" | head -20
    fi
  elif [ -f "tests/$name.err" ]; then
    if [ $code -ne 0 ] && grep -qF -- "$(cat "tests/$name.err")" <<< "$actual"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      echo "FAIL $name (exit $code): expected an error containing: $(cat "tests/$name.err")"
      echo "$actual" | head -10
    fi
  else
    fail=$((fail + 1))
    echo "FAIL $name: no .out or .err file"
  fi
done
echo "$pass passed, $fail failed"
[ $fail -eq 0 ]
