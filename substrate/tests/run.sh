#!/usr/bin/env bash
# Builds and runs every test, then checks that the cache gives each build back.
set -uo pipefail
shopt -s nullglob
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
host="$root/host/subhost.mjs"
builds="${OUT:-build}/tests"
rm -rf "${builds:?}"
mkdir -p "$builds"

# A cache of the suite's own, emptied, so that each test compiles its module: an
# expected output includes what a module prints while compiling, which a cached one does not.
cache="$root/$builds/cache"
rm -rf "${cache:?}"
mkdir -p "$cache"

same_program() {
  cmp -s "$1/program" "$2/program" || return 1
  while read -r l; do cmp -s "$1/$l.wasm" "$2/$l.wasm" || return 1; done < "$1/program"
}

pass=0
fail=0

tests=(tests/*.sub tests/substrate/*.sub tests/scheme/*.sub tests/bend/*.sub tests/ui/*.sub)
for t in "${tests[@]}"; do
  name="$(basename "$t" .sub)"
  dir="$(dirname "$t")"
  base="$dir/$name"
  program="$builds/${dir#tests}/$name"
  rm -rf "${program:?}"
  args=()
  if [ -f "$base.args" ]; then read -r -a args < "$base.args"; fi
  actual="$(cd "$dir" && "$root/bin/sub" build "$name.sub" -o "$root/$program" -c "$cache" 2>&1 &&
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
# The session tests. Backtrace lines are removed: they depend on the host.
for t in tests/session/*.sub; do
  name="$(basename "$t" .sub)"
  actual="$(cd tests/session && "$root/bin/sub" eval "$name.sub" -c "$cache" 2>&1 | grep -v '^    ')"
  if [ -f "tests/session/$name.out" ] && [ "$actual" = "$(cat "tests/session/$name.out")" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL tests/session/$name: output differs"
    diff <(echo "$actual") "tests/session/$name.out" | head -20
  fi
done
# order-a and order-b require the same two modules in either order: the same bytes.
for f in "$builds"/scheme/order-a/order-[mn].*.wasm; do
  if ! cmp -s "$f" "$builds/scheme/order-b/$(basename "$f")"; then
    fail=$((fail + 1))
    echo "FAIL tests/scheme/order-b: $(basename "$f") differs from order-a's"
  fi
done
again=0
for t in "${tests[@]}"; do
  name="$(basename "$t" .sub)"
  dir="$(dirname "$t")"
  program="$builds/${dir#tests}/$name"
  [ -f "$program/program" ] || continue
  rebuilt="$builds/again/${dir#tests}/$name"
  rm -rf "${rebuilt:?}"
  if ! (cd "$dir" && "$root/bin/sub" build "$name.sub" -o "$root/$rebuilt" -c "$cache" > /dev/null 2>&1); then
    fail=$((fail + 1))
    echo "FAIL $dir/$name: does not build again from the cache"
  elif ! same_program "$rebuilt" "$program"; then
    fail=$((fail + 1))
    echo "FAIL $dir/$name: built again from the cache, the program differs"
  else
    again=$((again + 1))
  fi
done
# A stale cache entry is not used: a required b, now does not, and b is gone.
stale="$builds/stale"
rm -rf "${stale:?}"
mkdir -p "$stale"
printf '(provide x)\n(func (x) -> i32 1)\n' > "$stale/b.sub"
printf '(require b "b.sub" x)\n(func (main) (write-int (x)) (newline))\n' > "$stale/a.sub"
first="$(bin/sub build "$stale/a.sub" -o "$stale/a" -c "$cache" 2>&1 && "$host" "$root/$stale/a" 2>&1)"
rm "$stale/b.sub"
printf '(func (main) (write-int 2) (newline))\n' > "$stale/a.sub"
second="$(bin/sub build "$stale/a.sub" -o "$stale/a" -c "$cache" 2>&1 && "$host" "$root/$stale/a" 2>&1)"
if [ "$first" = 1 ] && [ "$second" = 2 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL the stale cache entry: got $first, then $second"
fi
# Code run while compiling uses the running compiler's own modules, also when the sources differ
# from those it was built from, as when the seed builds changed ones: a test with Substrate macros
# builds from such sources and runs as it does here, unless a struct it relies on has changed.
changed="$builds/changed"
rm -rf "${changed:?}"
mkdir -p "$changed/tests/substrate"
cp -r compiler "$changed/"
cp tests/substrate/forms.sub "$changed/tests/substrate/"
from_changed() {
  "$host" "$root/build/sub" "$root/$changed" build tests/substrate/forms.sub -o "$root/$changed/out" \
    -p "$root/$changed" -d "$root/$changed" 2>&1 && "$host" "$root/$changed/out" 2>&1
}
echo ';; changed' >> "$changed/compiler/substrate.sub"
sed -i 's|^(provide datum srcloc scope-set$|& added|; s|^(struct srcloc \[|(struct added [a i32])\n&|' "$changed/compiler/syntax.sub"
if [ "$(from_changed)" = "$(cat tests/substrate/forms.out)" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL changed sources: tests/substrate/forms.sub does not build and run as it does here"
fi
sed -i 's|^(struct srcloc \[|(struct srcloc [unused i32] [|' "$changed/compiler/syntax.sub"
if grep -qF "whose srcloc differs" <<< "$(from_changed)"; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL changed sources: a changed srcloc is not refused"
fi
echo "$pass passed, $fail failed; $again built again from the cache"
[ $fail -eq 0 ]
