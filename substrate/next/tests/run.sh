#!/usr/bin/env bash
# Lifecycle: experimental. The new compiler's own tests: each
# next/tests/*.sub built by the new compiler (next/sub) and run with a
# host, build/subhost unless HOST names another (host/subhost.mjs runs
# programs on Node's V8), which runs the compiler too. The output checked
# is the build's, then the run's, as tests/run.sh checks it:
#
#   NAME.out   expected output of a successful run
#   NAME.err   a line that must appear in the output of a failing one
#
# Most are the kernel's tests of compile-time code (tests/) in the syntax
# module's contract (next/compiler/syntax.sub): their macros work on data
# in memory, and their outputs are those tests' own, but for where the
# forms that quote data in memory, longer than #' and #`, move an error's
# column. next/tests/fixtures holds the modules they require. OUT is where
# builds go (default build). In the dev shell:
#
#   next/tests/run.sh
set -uo pipefail
shopt -s nullglob
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
host="$root/${HOST:-build/subhost}"
builds="${OUT:-build}/next/tests"
mkdir -p "$builds"

pass=0
fail=0
for t in next/tests/*.sub; do
  name="$(basename "$t" .sub)"
  base="next/tests/$name"
  program="$builds/$name"
  rm -rf "${program:?}"
  actual="$(cd next/tests && ../sub build "$name.sub" -o "$root/$program" 2>&1 && "$host" "$root/$program" 2>&1)"
  code=$?
  problem=""
  if [ -f "$base.out" ]; then
    if [ $code -ne 0 ] || [ "$actual" != "$(cat "$base.out")" ]; then problem="output differs (exit $code)"; fi
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
