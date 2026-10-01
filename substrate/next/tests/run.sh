#!/usr/bin/env bash
# Lifecycle: experimental. The new compiler's own tests: each
# next/tests/*.sub, next/tests/c/*.sub and next/tests/substrate/*.sub
# built by the new compiler (next/sub), in its own directory, and run with
# a host, build/subhost unless HOST names another (host/subhost.mjs runs
# programs on Node's V8), which runs the compiler too. The output checked
# is the build's, then the run's, as tests/run.sh checks it:
#
#   NAME.out   expected output of a successful run
#   NAME.err   a line that must appear in the output of a failing one
#   NAME.args  the run's command-line arguments, on one line
#
# Most are the kernel's tests (tests/) of compile-time code and of
# syntax-match (next/c/syntax-match.sub), on the new compiler's kernel
# module (next/compiler/kernel.sub): their macros work
# on data in memory, i32s, where they worked on GC objects, and their
# outputs are those tests' own. next/tests/fixtures holds the modules they
# require. next/tests/c has the C example's tests (tests/c), on the C-like
# Lisp as the new compiler builds it (next/c); next/tests/bend has the
# tests of Bend as the new compiler builds it (next/bend), and
# next/tests/substrate has the
# tests of Substrate as the new compiler builds it (next/substrate). Then,
# as tests/run.sh does, the cache (spec 3.7): each program built again
# from it is the same, and a stale entry is not used. OUT is where builds
# go (default build). In the dev shell:
#
#   next/tests/run.sh
set -uo pipefail
shopt -s nullglob
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
host="$root/${HOST:-build/subhost}"
builds="${OUT:-build}/next/tests"
mkdir -p "$builds"

# The suite keeps compiled modules in a cache of its own, removed first,
# so that every test compiles its module: a test's expected output
# includes what the module prints while compiling, and a module loaded
# from the cache prints nothing. Each program is then built again from
# the cache, which must give the same bytes (below).
cache="$root/$builds/cache"
rm -rf "${cache:?}"
mkdir -p "$cache"

# The program in directory $1 is byte for byte the one in $2.
same_program() {
  cmp -s "$1/program" "$2/program" || return 1
  while read -r l; do cmp -s "$1/$l.wasm" "$2/$l.wasm" || return 1; done < "$1/program"
}

pass=0
fail=0

# A compiled file for compiled-import.sub: a fixture's closure (spec 3.7).
mkdir -p "$builds/compiled"
(cd next/tests/fixtures && "$root/next/sub" build geometry.sub -o "$root/$builds/compiled/geometry" \
   -m "$root/$builds/compiled/geometry.subc" -c "$cache" > /dev/null) ||
  { echo "FAIL building next/tests/fixtures/geometry.sub as a compiled file"; fail=$((fail + 1)); }

tests=(next/tests/*.sub next/tests/c/*.sub next/tests/substrate/*.sub next/tests/cells/*.sub next/tests/bend/*.sub)
for t in "${tests[@]}"; do
  name="$(basename "$t" .sub)"
  dir="$(dirname "$t")"
  base="$dir/$name"
  program="$builds/${dir#next/tests}/$name"
  rm -rf "${program:?}"
  args=()
  if [ -f "$base.args" ]; then read -r -a args < "$base.args"; fi
  actual="$(cd "$dir" && "$root/next/sub" build "$name.sub" -o "$root/$program" -c "$cache" 2>&1 &&
            "$host" "$root/$program" ${args[@]+"${args[@]}"} 2>&1)"
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
# A module compiles to the same bytes whatever the run compiled before it
# (spec 3.5): substrate/order-a and order-b require the same two modules in
# either order.
for f in "$builds"/substrate/order-a/order-[mn].*.wasm; do
  if ! cmp -s "$f" "$builds/substrate/order-b/$(basename "$f")"; then
    fail=$((fail + 1))
    echo "FAIL next/tests/substrate/order-b: $(basename "$f") differs from order-a's"
  fi
done
# The cache (spec 3.7): every program built again, its modules loaded
# from the cache, is byte for byte what the first build wrote.
again=0
for t in "${tests[@]}"; do
  name="$(basename "$t" .sub)"
  dir="$(dirname "$t")"
  program="$builds/${dir#next/tests}/$name"
  [ -f "$program/program" ] || continue
  rebuilt="$builds/again/${dir#next/tests}/$name"
  rm -rf "${rebuilt:?}"
  if ! (cd "$dir" && "$root/next/sub" build "$name.sub" -o "$root/$rebuilt" -c "$cache" > /dev/null 2>&1); then
    fail=$((fail + 1))
    echo "FAIL $dir/$name: does not build again from the cache"
  elif ! same_program "$rebuilt" "$program"; then
    fail=$((fail + 1))
    echo "FAIL $dir/$name: built again from the cache, the program differs"
  else
    again=$((again + 1))
  fi
done
# A cache entry for a module whose source has changed is not used, and
# the requires it recorded are not looked at (spec 3.7): a required b,
# and now does not, and b is gone.
stale="$builds/stale"
rm -rf "${stale:?}"
mkdir -p "$stale"
print="(require print \"$root/lib/print.sub\" write-int newline)"
printf '(provide x)\n(func (x) -> i32 1)\n' > "$stale/b.sub"
printf '%s\n(require b "b.sub" x)\n(func (main) (write-int (x)) (newline))\n' "$print" > "$stale/a.sub"
first="$(next/sub build "$stale/a.sub" -o "$stale/a" -c "$cache" 2>&1 && "$host" "$root/$stale/a" 2>&1)"
rm "$stale/b.sub"
printf '%s\n(func (main) (write-int 2) (newline))\n' "$print" > "$stale/a.sub"
second="$(next/sub build "$stale/a.sub" -o "$stale/a" -c "$cache" 2>&1 && "$host" "$root/$stale/a" 2>&1)"
if [ "$first" = 1 ] && [ "$second" = 2 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL the stale cache entry: got $first, then $second"
fi
echo "$pass passed, $fail failed; $again built again from the cache"
[ $fail -eq 0 ]
