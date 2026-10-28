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

cache="$root/$builds/cache"
rm -rf "${cache:?}"
mkdir -p "$cache"

same_program() {
  cmp -s "$1/program" "$2/program" || return 1
  while read -r l; do cmp -s "$1/$l.wasm" "$2/$l.wasm" || return 1; done < "$1/program"
}

pass=0
fail=0
built=0
unbuilt=0

# A certificate for the TLS tests, which their clients trust because it is granted.
mkdir -p "$builds/tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -keyout "$builds/tls/key.pem" -out "$builds/tls/cert.pem" 2> /dev/null

tests=(tests/*.sub tests/substrate/*.sub tests/scheme/*.sub tests/bend/*.sub tests/ui/*.sub tests/events/*.sub tests/http/*.sub
       tests/crypto/*.sub tests/encoding/*.sub tests/meta/*.sub tests/log/*.sub tests/compress/*.sub tests/cmd/*.sub
       tests/packages/*.sub tests/sqlite/*.sub)
for t in "${tests[@]}"; do
  name="$(basename "$t" .sub)"
  dir="$(dirname "$t")"
  base="$dir/$name"
  program="$builds/${dir#tests}/$name"
  rm -rf "${program:?}"
  args=()
  if [ -f "$base.args" ]; then read -r -a args < "$base.args"; fi
  args=("${args[@]/@program/$root/$program}")
  args=("${args[@]//@build/$root/$builds}")
  options=()
  if [ -f "$base.host" ]; then read -r -a options < "$base.host"; fi
  options=("${options[@]//@build/$root/$builds}")
  input=/dev/null
  if [ -f "$base.in" ]; then input="$root/$base.in"; fi
  actual="$(cd "$dir" && "$root/bin/sub" build "$name.sub" -o "$root/$program" -c "$cache" 2>&1 &&
            timeout 60 "$host" ${options[@]+"${options[@]}"} "$root/$program" ${args[@]+"${args[@]}"} 2>&1 < "$input")"
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
# Each module in cmd, std, packages, bench, host, tests/web and tests/proxy builds, except the pieces in bench/bend/compile.
mapfile -t modules < <(find cmd std packages bench host tests/web tests/proxy -name '*.sub' -not -path 'bench/bend/compile/*' | sort)
for m in "${modules[@]}"; do
  actual="$(cd "$(dirname "$m")" && "$root/bin/sub" build "$(basename "$m")" -o "$root/$builds/modules/${m%.sub}" -c "$cache" 2>&1)"
  if [ $? -eq 0 ]; then
    built=$((built + 1))
  else
    unbuilt=$((unbuilt + 1))
    echo "FAIL $m: does not build"
    echo "$actual" | head -10
  fi
done
# The event tests again, against the real modules and the server in tests/events/fixtures.
server=""
for t in tests/events/*.sub; do
  name="$(basename "$t" .sub)"
  [ -f "tests/events/$name.real" ] || continue
  if [ -z "$server" ]; then
    : > "$builds/servers.url"
    (cd tests/events/fixtures && "$root/bin/sub" build servers.sub -o "$root/$builds/events/servers" -c "$cache")
    "$host" -N=127.0.0.1 -R="$root/tests/events/files" "$root/$builds/events/servers" "$root/tests/events/files" \
      > "$builds/servers.url" & server=$!
    for i in $(seq 50); do [ -s "$builds/servers.url" ] && break; sleep 0.1; done
    url="$(cat "$builds/servers.url")"
  fi
  actual="$(cd tests/events && timeout 60 "$host" -N=127.0.0.1 -R=. "$root/$builds/events/$name" "$url" "ws${url#http}" 2>&1)"
  code=$?
  if [ $code -eq 0 ] && [ "$actual" = "$(cat "tests/events/$name.out")" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL tests/events/$name, with the real modules: output differs (exit $code)"
    diff <(echo "$actual") "tests/events/$name.out" | head -20
  fi
done
[ -n "$server" ] && kill "$server"
# The session tests.
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
# A stale cache entry is not used.
stale="$builds/stale"
rm -rf "${stale:?}"
mkdir -p "$stale"
printf '(provide x)\n(define (x) -> i32 1)\n' > "$stale/b.sub"
printf '(require b "b.sub" x)\n(define (main) (printf "~a~n" (x)))\n' > "$stale/a.sub"
first="$(bin/sub build "$stale/a.sub" -o "$stale/a" -c "$cache" 2>&1 && "$host" "$root/$stale/a" 2>&1)"
rm "$stale/b.sub"
printf '(define (main) (printf "~a~n" 2))\n' > "$stale/a.sub"
second="$(bin/sub build "$stale/a.sub" -o "$stale/a" -c "$cache" 2>&1 && "$host" "$root/$stale/a" 2>&1)"
if [ "$first" = 1 ] && [ "$second" = 2 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL the stale cache entry: got $first, then $second"
fi
# Cache entries cut short are built again.
cut="$builds/cut"
rm -rf "${cut:?}"
mkdir -p "$cut/cache"
printf '(define (main) (printf "~a~n" 3))\n' > "$cut/c.sub"
bin/sub build "$cut/c.sub" -o "$cut/c" -c "$cut/cache" > /dev/null 2>&1
for f in "$cut"/cache/*.subc; do truncate -s 100 "$f"; done
whole="$(bin/sub build "$cut/c.sub" -o "$cut/c" -c "$cut/cache" 2>&1 && "$host" "$root/$cut/c" 2>&1)"
if [ "$whole" = 3 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL the cache entries cut short: got $whole"
fi
# A build that traps fails.
if (cd tests && "$root/bin/sub" build err-macro-trap.sub -o "$root/$builds/trapped" -c "$cache" > /dev/null 2>&1); then
  fail=$((fail + 1))
  echo "FAIL tests/err-macro-trap: the build traps and exits 0"
else
  pass=$((pass + 1))
fi
# A test with macros builds against changed compiler sources and runs as it does here.
changed="$builds/changed"
rm -rf "${changed:?}"
mkdir -p "$changed/tests/substrate"
cp -r compiler "$changed/"
mkdir -p "$changed/host"
cp host/fs.sub "$changed/host/"
cp tests/substrate/forms.sub "$changed/tests/substrate/"
from_changed() {
  "$host" -R -W "$root/build/sub" "$root/$changed" build tests/substrate/forms.sub -o "$root/$changed/out" \
    -d "$root/$changed" 2>&1 && "$host" "$root/$changed/out" 2>&1
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
echo "$built modules built, $unbuilt failed"
echo "$pass passed, $fail failed; $again built again from the cache"
[ $fail -eq 0 ] && [ $unbuilt -eq 0 ]
