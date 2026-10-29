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

# Archives for tests/archive/tar.sub, made by GNU tar in each of its formats.
tarred="$builds/tar"
deep="pkg/a-directory-whose-name-is-long-enough-that/a-path-through-it-is-longer-than-the-hundred-bytes-of-a-name"
mkdir -p "$tarred/tree/$deep"
printf 'hello\n' > "$tarred/tree/pkg/hello.txt"
printf 'deep\n' > "$tarred/tree/$deep/deep.txt"
: > "$tarred/tree/pkg/empty"
ln -s hello.txt "$tarred/tree/pkg/link"
for format in ustar gnu pax; do
  tar --sort=name --format="$format" -cf "$tarred/$format.tar" -C "$tarred/tree" pkg
done
tar --sort=name --format=pax --pax-option=comment=a-global-header -cf "$tarred/global.tar" -C "$tarred/tree" pkg
head -c 600 /dev/zero | tr '\0' x > "$tarred/not.tar"
head -c 1000 "$tarred/ustar.tar" > "$tarred/short.tar"

tests=(tests/*.sub tests/substrate/*.sub tests/scheme/*.sub tests/bend/*.sub tests/ui/*.sub tests/events/*.sub tests/http/*.sub
       tests/crypto/*.sub tests/encoding/*.sub tests/meta/*.sub tests/log/*.sub tests/compress/*.sub tests/cmd/*.sub
       tests/packages/*.sub tests/packages/cside/tests/*.sub tests/packages/bounds/*.sub tests/sqlite/*.sub
       tests/archive/*.sub)
for t in "${tests[@]}"; do
  name="$(basename "$t" .sub)"
  [ "$name" = package ] && continue
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
mapfile -t modules < <(find cmd std packages bench host tests/web tests/proxy -name '*.sub' -not -name package.sub \
                         -not -path 'bench/bend/compile/*' | sort)
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
# A package built from two directories gives the same program.
moved="$builds/moved"
rm -rf "${moved:?}"
mkdir -p "$moved/one" "$moved/two"
cp -r tests/packages/names.sub tests/packages/tools tests/packages/app "$moved/one/"
cp -r tests/packages/names.sub tests/packages/tools tests/packages/app "$moved/two/"
bin/sub build "$moved/one/names.sub" -o "$moved/one-built" -c "$cache" > /dev/null 2>&1
bin/sub build "$moved/two/names.sub" -o "$moved/two-built" -c "$cache" > /dev/null 2>&1
if [ -f "$moved/one-built/program" ] && same_program "$moved/one-built" "$moved/two-built"; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL a package built from two directories: the programs differ"
fi
# An edit compiles again only the module edited and those that require it.
edited="$builds/edited"
rm -rf "${edited:?}"
mkdir -p "$edited"
printf '(provide b)\n(define (b) -> i32 1)\n' > "$edited/b.sub"
printf '(require b "b.sub")\n(provide a)\n(define (a) -> i32 (b:b))\n' > "$edited/a.sub"
printf '(provide c)\n(define (c) -> i32 3)\n' > "$edited/c.sub"
printf '(require a "a.sub")\n(require c "c.sub")\n(define (main) (printf "~a~n" (+ (a:a) (c:c))))\n' > "$edited/main.sub"
bin/sub build "$edited/main.sub" -o "$edited/built" -c "$edited/cache" > /dev/null 2>&1
touch "$edited/marker"
printf '(provide b)\n(define (b) -> i32 2)\n' > "$edited/b.sub"
total="$(bin/sub build "$edited/main.sub" -o "$edited/built" -c "$edited/cache" 2>&1 && "$host" "$root/$edited/built" 2>&1)"
compiled="$(find "$edited/cache" -name '*.subc' -newer "$edited/marker" | wc -l)"
if [ "$total" = 5 ] && [ "$compiled" = 3 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL an edit: got $total, with $compiled modules compiled again, not 3"
fi
# sub builds a program into build/ of its package, or of its directory outside packages, and runs it as the host does,
# with the host's stack, its arguments and its exit code.
ran="$builds/ran"
rm -rf "${ran:?}"
mkdir -p "$ran"
printf '(define (depth [n i32]) -> i32 (if (== n 0) 0 (+ 1 (depth (- n 1)))))\n' > "$ran/count.sub"
printf '(define (main) (printf "~a ~a~n" (-> (host-args) length) (depth 25000)) (host-exit 4))\n' >> "$ran/count.sub"
counted="$(cd "$ran" && "$root/bin/sub" run count.sub a b c 2>&1)"
code=$?
bin/sub build "$moved/one/app/app.sub" -c "$cache" > /dev/null 2>&1
if [ "$counted" = "3 25000" ] && [ $code -eq 4 ] && [ -f "$ran/build/count/program" ] && [ -f "$moved/one/app/build/app/program" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL sub run: got $counted and exit $code, or a program not in build/"
fi
# A package builds only from the files its hash covers: not from its build/, nor through a link.
own="$builds/own"
rm -rf "${own:?}"
mkdir -p "$own/p/build"
printf '(package p (version "0.1.0"))\n' > "$own/p/package.sub"
printf '(provide y)\n(define (y) -> i32 1)\n' > "$own/p/build/y.sub"
printf '(provide z)\n(define (z) -> i32 1)\n' > "$own/z.sub"
ln -s ../z.sub "$own/p/z.sub"
printf '(require y "build/y.sub")\n(define (main) (printf "~a~n" (y:y)))\n' > "$own/p/built.sub"
printf '(require z "z.sub")\n(define (main) (printf "~a~n" (z:z)))\n' > "$own/p/linked.sub"
from_build="$(bin/sub build "$own/p/built.sub" -c "$cache" 2>&1)"
from_link="$(bin/sub build "$own/p/linked.sub" -c "$cache" 2>&1)"
if [[ "$from_build" == *'"build/y.sub" is not one of the files of p'* ]] &&
   [[ "$from_link" == *'"z.sub" is not one of the files of p'* ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL a package's own files: got $from_build and $from_link"
fi
# A C module that does not export __wasm_call_ctors, which runs its constructors, is refused.
unexported="$builds/unexported"
rm -rf "${unexported:?}"
mkdir -p "$unexported"
printf 'int one(void) { return 1; }\n' > "$unexported/c.c"
wasm32-unknown-wasi-clang -O2 -fPIC -fvisibility=default -nostdlib -shared -Wl,--experimental-pic -Wl,--no-entry \
  -o "$unexported/c.wasm" "$unexported/c.c"
printf '(require c "c.wasm")\n(define (main) (printf "~a~n" (c:one)))\n' > "$unexported/main.sub"
refused="$(bin/sub build "$unexported/main.sub" -c "$cache" 2>&1)"
if [[ "$refused" == *"c.wasm does not export __wasm_call_ctors"* ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL a C module without its constructors: got $refused"
fi
# sub hash prints the hash a dependency pins, and sub map the module map a program is built with.
hashed="$(bin/sub hash tests/packages/maps/lib 2>&1)"
mapped="$(bin/sub map tests/packages/names.sub 2>&1)"
if [ "$hashed" = "$(grep -o 'sha256:[0-9a-f]\{64\}' tests/packages/package-library.out | head -1)" ] &&
   [[ "$mapped" == *'(root names "'*'(uses (tools tools) (app app)))'* ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL sub hash and map: got $hashed and $mapped"
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
  "$host" -R -W "$root/build/compiler" "$root/$changed" build tests/substrate/forms.sub -o "$root/$changed/out" \
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
# Url dependencies: the packages in tests/fetch/archives, made into archives here by GNU tar and answered by the fake
# fetch, and each test with a store of its own in tests/fetch/build.
served="$root/$builds/fetch/served"
mkdir -p "$served"
for p in tests/fetch/archives/*/; do
  p="$(basename "$p")"
  tar --sort=name --format=pax -czf "$served/$p.tar.gz" -C tests/fetch/archives "$p"
done
printf 'this is not an archive\n' > "$served/junk.tar.gz"
tar -P --sort=name --format=pax --transform 's,^json/json.sub,json/../../escaped.sub,' -czf "$served/hostile.tar.gz" \
  -C tests/fetch/archives json
rm -rf tests/fetch/build
fetched() {
  (cd tests/fetch && "$host" -A --fake=fetch:"$served" "$root/build/sub" "$root" "$@" -c "$cache" 2>&1)
}
for t in tests/fetch/*.sub; do
  name="$(basename "$t" .sub)"
  base="tests/fetch/$name"
  program="$builds/fetch/$name"
  actual="$(fetched build "$name.sub" -o "$root/$program" -P "build/$name" && timeout 60 "$host" "$root/$program" 2>&1)"
  code=$?
  if [ -f "$base.out" ] && [ $code -eq 0 ] && [ "$actual" = "$(cat "$base.out")" ]; then
    pass=$((pass + 1))
  elif [ -f "$base.err" ] && [ $code -ne 0 ] && grep -qF -- "$(cat "$base.err")" <<< "$actual"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL $base: got"
    echo "$actual" | head -10
  fi
done
if [ -e tests/fetch/build/escaped.sub ] || [ -e tests/fetch/escaped.sub ]; then
  fail=$((fail + 1))
  echo "FAIL tests/fetch/err-hostile: a file was written outside the store"
fi
# A package already in the store is not fetched again, and sub fetch URL prints the dependency that pins a package,
# then fetches the packages it needs.
stored="$(fetched build app.sub -o "$root/$builds/fetch/again" -P build/app && "$host" "$root/$builds/fetch/again" 2>&1)"
fetched_url="$(fetched fetch http://fake/outer.tar.gz -P build/fetch-url)"
if [ "$stored" = 42 ] && [ "$fetched_url" = "$(cat tests/fetch/fetch-url.out)" ] &&
   [ -d "tests/fetch/build/fetch-url/$(grep -o 'sha256:[0-9a-f]*' tests/fetch/fetch-url.out | cut -c8-)" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL fetching again and sub fetch URL: got $stored, then $fetched_url"
fi
echo "$built modules built, $unbuilt failed"
echo "$pass passed, $fail failed; $again built again from the cache"
[ $fail -eq 0 ] && [ $unbuilt -eq 0 ]
