#!/usr/bin/env bash
# Lifecycle: test harness.
#
# Build every tests/*.sub and examples/*.sub with bin/sub build and run it
# with a host, build/subhost unless HOST names another (host/subhost.mjs
# runs programs on Node's V8); the output checked is the build's, then the
# run's.
# Next to each file:
#   NAME.out      expected output of a successful run
#   NAME.err      a line that must appear in the output of a failing run
#   NAME.args     the run's command-line arguments, on one line
#   NAME.imports  the instance names the compiled phase-0 linklet may import
#                 from, one per line (checks that programs import only what
#                 they use)
#
# OUT is where builds go (default build).
set -uo pipefail
shopt -s nullglob
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
compiler="$root/bin/sub"
builds="${OUT:-build}"
host="$root/${HOST:-build/subhost}"

# Build the syntax library once first, so library compile notices stay out
# of test output.
mkdir -p build
"$compiler" syntax-library -o build/syntax.wasm > /dev/null
wasm-tools validate build/syntax.wasm || { echo "FAIL syntax.wasm does not validate"; exit 1; }

pass=0
fail=0
for t in tests/*.sub examples/*.sub; do
  dir="$(dirname "$t")"
  name="$(basename "$t" .sub)"
  base="$dir/$name"
  out="$builds/$dir"
  mkdir -p "$out"
  program="$out/$name"
  args=()
  if [ -f "$base.args" ]; then read -r -a args < "$base.args"; fi
  actual="$(cd "$dir" && "$compiler" build "$name.sub" -o "$root/$program" 2>&1 &&
            "$host" "$root/$program" "${args[@]}" 2>&1)"
  code=$?
  problem=""
  if [ -f "$base.out" ]; then
    if [ $code -ne 0 ] || [ "$actual" != "$(cat "$base.out")" ]; then
      problem="output differs (exit $code)"
    elif ! while read -r linklet; do
             wasm-tools validate "$program/$linklet.wasm" || exit 1; done < "$program/program"; then
      problem="a compiled linklet does not validate"
    elif [ -f "$base.imports" ]; then
      entry="$(tail -n 1 "$program/program")"
      # Instance names without the hash that ends a module's name (spec 3.2).
      imports="$(wasm-tools print "$program/$entry.wasm" | sed -n 's/^ *(import "\([^"]*\)".*/\1/p' |
                 sed 's/\.[0-9a-f]\{12\}@/@/' | sort -u)"
      if [ "$imports" != "$(sort -u "$base.imports")" ]; then
        problem="imports from: $(echo $imports), expected: $(echo $(cat "$base.imports"))"
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
