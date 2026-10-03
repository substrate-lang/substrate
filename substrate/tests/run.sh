#!/usr/bin/env bash
# Lifecycle: test harness. Each tests/*.sub, tests/base/*.sub,
# tests/substrate/*.sub, tests/bend/*.sub and tests/ui/*.sub built by the compiler
# (bin/sub), in its own directory, and run with a host, build/subhost
# unless HOST names another (host/subhost.mjs runs programs on Node's
# V8), which runs the compiler too. The output checked is the build's,
# then the run's:
#
#   NAME.out   expected output of a successful run
#   NAME.err   a line that must appear in the output of a failing one
#   NAME.args  the run's command-line arguments, on one line
#
# tests/*.sub are the kernel's tests: of the kernel language, of
# compile-time code and of syntax-match (compiler/syntax-match.sub), on
# the kernel module (compiler/kernel.sub); tests/fixtures holds the
# modules they require. tests/base has the C-like Lisp's tests
# (compiler/base), tests/substrate Substrate's (lib/substrate), and
# tests/bend Bend's (lib/bend). tests/ui has the tests of the web
# libraries that need no browser (lib/web): they print the page changes
# a view produces, check the error messages for templates that are
# wrong, test reading files and the game library (collision, keys,
# timers, sound, its containers and its formatting), print the GPU
# commands that a program and the sprite renderer write, and play the
# example games without their pages. tests/session has the session
# tests, which bin/sub eval runs. Then the cache (spec 3.7): each
# program built again from it is the same, and a stale entry is not
# used. OUT is where builds go (default build). In the dev shell:
#
#   tests/run.sh
set -uo pipefail
shopt -s nullglob
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
host="$root/${HOST:-build/subhost}"
builds="${OUT:-build}/tests"
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
(cd tests/fixtures && "$root/bin/sub" build geometry.sub -o "$root/$builds/compiled/geometry" \
   -m "$root/$builds/compiled/geometry.subc" -c "$cache" > /dev/null) ||
  { echo "FAIL building tests/fixtures/geometry.sub as a compiled file"; fail=$((fail + 1)); }

tests=(tests/*.sub tests/base/*.sub tests/substrate/*.sub tests/bend/*.sub tests/ui/*.sub)
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
# The session tests (tests/session). `bin/sub eval NAME.sub` evaluates
# the file's forms one at a time, each as one input of a session (see
# "sessions" in compiler/expander.sub). Its output,
# including the error messages of inputs that fail, must equal NAME.out.
# Backtrace lines (which start with four spaces) are removed first,
# because their content depends on the host.
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
# A module compiles to the same bytes whatever the run compiled before it
# (spec 3.5): tests/substrate/order-a and order-b require the same two modules in
# either order.
for f in "$builds"/substrate/order-a/order-[mn].*.wasm; do
  if ! cmp -s "$f" "$builds/substrate/order-b/$(basename "$f")"; then
    fail=$((fail + 1))
    echo "FAIL tests/substrate/order-b: $(basename "$f") differs from order-a's"
  fi
done
# The cache (spec 3.7): every program built again, its modules loaded
# from the cache, is byte for byte what the first build wrote.
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
# A cache entry for a module whose source has changed is not used, and
# the requires it recorded are not looked at (spec 3.7): a required b,
# and now does not, and b is gone.
stale="$builds/stale"
rm -rf "${stale:?}"
mkdir -p "$stale"
print="(require print \"$root/compiler/print.sub\" write-int newline)"
printf '(provide x)\n(func (x) -> i32 1)\n' > "$stale/b.sub"
printf '%s\n(require b "b.sub" x)\n(func (main) (write-int (x)) (newline))\n' "$print" > "$stale/a.sub"
first="$(bin/sub build "$stale/a.sub" -o "$stale/a" -c "$cache" 2>&1 && "$host" "$root/$stale/a" 2>&1)"
rm "$stale/b.sub"
printf '%s\n(func (main) (write-int 2) (newline))\n' "$print" > "$stale/a.sub"
second="$(bin/sub build "$stale/a.sub" -o "$stale/a" -c "$cache" 2>&1 && "$host" "$root/$stale/a" 2>&1)"
if [ "$first" = 1 ] && [ "$second" = 2 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL the stale cache entry: got $first, then $second"
fi
echo "$pass passed, $fail failed; $again built again from the cache"
[ $fail -eq 0 ]
