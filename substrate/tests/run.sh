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

# bin/sub keeps compiled modules in build/cache. The suite removes it
# first, so that every test compiles its module: a test's expected output
# includes what the module prints while compiling, and a module loaded
# from the cache prints nothing. Each program is then built again from
# the cache, which must give the same bytes (below).
rm -rf "$root/build/cache"
# Build the kernel module once first, so its compile notices stay out
# of test output.
mkdir -p build
"$compiler" kernel -o build/kernel.wasm > /dev/null
wasm-tools validate build/kernel.wasm || { echo "FAIL kernel.wasm does not validate"; exit 1; }

# Each linklet of the program in directory $1 validates.
validates() { while read -r l; do wasm-tools validate "$1/$l.wasm" || return 1; done < "$1/program"; }
# The program in directory $1 is byte for byte the one in $2.
same_program() {
  cmp -s "$1/program" "$2/program" || return 1
  while read -r l; do cmp -s "$1/$l.wasm" "$2/$l.wasm" || return 1; done < "$1/program"
}

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
            "$host" "$root/$program" ${args[@]+"${args[@]}"} 2>&1)"
  code=$?
  problem=""
  if [ -f "$base.out" ]; then
    if [ $code -ne 0 ] || [ "$actual" != "$(cat "$base.out")" ]; then
      problem="output differs (exit $code)"
    elif ! validates "$program"; then
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
# A module compiles to the same bytes whatever the run compiled before it
# (spec 3.5): order-a and order-b require the same two modules in either
# order.
for f in "$builds"/tests/order-a/order-[mn].*.wasm; do
  if ! cmp -s "$f" "$builds/tests/order-b/$(basename "$f")"; then
    fail=$((fail + 1))
    echo "FAIL tests/order-b: $(basename "$f") differs from tests/order-a's"
  fi
done
# The cache (spec 3.7): every program built again, its modules loaded
# from the cache, is byte for byte what the first build wrote.
again=0
for t in tests/*.sub examples/*.sub; do
  dir="$(dirname "$t")"
  name="$(basename "$t" .sub)"
  program="$builds/$dir/$name"
  [ -f "$program/program" ] || continue
  rebuilt="$builds/again/$dir/$name"
  rm -rf "$rebuilt"
  mkdir -p "$rebuilt"
  if (cd "$dir" && "$compiler" build "$name.sub" -o "$root/$rebuilt" > /dev/null 2>&1) && same_program "$rebuilt" "$program"; then
    again=$((again + 1))
  else
    fail=$((fail + 1))
    echo "FAIL $dir/$name: built again from the cache, the program differs"
  fi
done
echo "$pass passed, $fail failed; $again programs rebuilt from the cache"
[ $fail -eq 0 ]
