#!/usr/bin/env bash
# Builds and runs every test, then checks that the cache gives each build back.
set -uo pipefail
shopt -s nullglob
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
host="$root/substrate/host/subhost.mjs"
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
# Each module in cmd, std, packages, bench, substrate/host, tests/web and tests/proxy builds, except the pieces in
# bench/bend/compile.
mapfile -t modules < <(find cmd std packages bench substrate/host tests/web tests/proxy -name '*.sub' \
                         -not -name package.sub -not -path 'bench/bend/compile/*' | sort)
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
# An edit compiles again only the module edited and those that require it, and its entry replaces the old one.
edited="$builds/edited"
rm -rf "${edited:?}"
mkdir -p "$edited"
printf '(provide b)\n(define (b) -> i32 1)\n' > "$edited/b.sub"
printf '(require b "b.sub")\n(provide a)\n(define (a) -> i32 (b:b))\n' > "$edited/a.sub"
printf '(provide c)\n(define (c) -> i32 3)\n' > "$edited/c.sub"
printf '(require a "a.sub")\n(require c "c.sub")\n(define (main) (printf "~a~n" (+ (a:a) (c:c))))\n' > "$edited/main.sub"
bin/sub build "$edited/main.sub" -o "$edited/built" -c "$edited/cache" > /dev/null 2>&1
entries="$(find "$edited/cache" -name '*.subc' | wc -l)"
touch "$edited/marker"
printf '(provide b)\n(define (b) -> i32 2)\n' > "$edited/b.sub"
total="$(bin/sub build "$edited/main.sub" -o "$edited/built" -c "$edited/cache" 2>&1 && "$host" "$root/$edited/built" 2>&1)"
compiled="$(find "$edited/cache" -name '*.subc' -newer "$edited/marker" | wc -l)"
if [ "$total" = 5 ] && [ "$compiled" = 3 ] && [ "$(find "$edited/cache" -name '*.subc' | wc -l)" = "$entries" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL an edit: got $total, with $compiled modules compiled again, not 3, or more entries than $entries"
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
# A package's hash covers its files and nothing else: not a README, build output, tests or a module nothing requires.
walked="$builds/walked"
rm -rf "${walked:?}"
cp -r tests/packages/walked "$walked"
before="$(bin/sub hash "$walked" 2>&1)"
mkdir -p "$walked/dist" "$walked/tests"
printf 'notes\n' > "$walked/README"
printf 'built\n' > "$walked/dist/program"
printf '(provide u)\n\n(define (u) -> i32 6)\n' > "$walked/unused.sub"
printf '(require w walked)\n(define (main) (printf "~a~n" (w:w)))\n' > "$walked/tests/use.sub"
after="$(bin/sub hash "$walked" 2>&1)"
printf '(provide d)\n\n(define (d) -> i32 7)\n' > "$walked/lib/deep/deep.sub"
deeper="$(bin/sub hash "$walked" 2>&1)"
used="$(bin/sub build "$walked/tests/use.sub" -o "$walked/use" -c "$cache" 2>&1 && "$host" "$root/$walked/use" 2>&1)"
if [[ "$before" == sha256:* ]] && [ "$after" = "$before" ] && [ "$deeper" != "$before" ] && [ "$used" = 8 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL a package's hash and its files: got $before, $after, $deeper and $used"
fi
# A module among a package's files requires only its files, in any build: a test of the package may require any file
# in its directory, but not a module of the package whose macro requires another.
held="$builds/held"
rm -rf "${held:?}"
mkdir -p "$held/q/tests"
printf '(package q (version "0.1.0"))\n' > "$held/q/package.sub"
cat > "$held/q/pull.sub" <<'EOF'
(begin-for-syntax
  (require-unqualified macros compiler/macros)
  (define (pull [stx datum]) -> datum #'(require h "hidden.sub")))
(define-syntax pull pull)
(provide pull)
EOF
printf '(provide h)\n(define (h) -> i32 1)\n' > "$held/q/hidden.sub"
printf '(require p "pull.sub")\n(p:pull)\n(provide v)\n(define (v) -> i32 2)\n' > "$held/q/q.sub"
printf '(require h "../hidden.sub")\n(define (main) (printf "~a~n" (h:h)))\n' > "$held/q/tests/private.sub"
printf '(require q "../q.sub")\n(define (main) (printf "~a~n" (q:v)))\n' > "$held/q/tests/public.sub"
private="$(bin/sub build "$held/q/tests/private.sub" -o "$held/private" -c "$cache" 2>&1 && "$host" "$root/$held/private" 2>&1)"
public="$(bin/sub build "$held/q/tests/public.sub" -o "$held/public" -c "$cache" 2>&1)"
if [ "$private" = 1 ] && [[ "$public" == *'"hidden.sub" is not one of the files of q'* ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL a package's files in a test's build: got $private and $public"
fi
# Nothing in a package is read through a link, which can lead outside it: not by a test, nor by one of its files.
linked="$builds/linked"
rm -rf "${linked:?}"
mkdir -p "$linked/p/tests" "$linked/elsewhere"
printf '(package p (version "0.1.0"))\n' > "$linked/p/package.sub"
printf '(provide z)\n(define (z) -> i32 1)\n' > "$linked/elsewhere/z.sub"
ln -s ../elsewhere "$linked/p/lib"
ln -s ../elsewhere/z.sub "$linked/p/z.sub"
printf '(provide v)\n(define (v) -> i32 2)\n' > "$linked/p/p.sub"
printf '(require z "../lib/z.sub")\n(define (main) (printf "~a~n" (z:z)))\n' > "$linked/p/tests/t.sub"
tested="$(bin/sub build "$linked/p/tests/t.sub" -o "$linked/t" -c "$cache" 2>&1)"
printf '(require z "z.sub")\n(provide v)\n(define (v) -> i32 (z:z))\n' > "$linked/p/p.sub"
hashed="$(bin/sub hash "$linked/p" 2>&1)"
if [[ "$tested" == *'"../lib/z.sub" goes through a link in the package p'* ]] &&
   [[ "$hashed" == *'z.sub goes through a link in the package p'* ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL links in a package: got $tested and $hashed"
fi
# Another package requires only a package's exports: not a module an export loads, nor one no longer exported when the
# requiring module comes from the cache, nor one a macro of the package requires into the other package's module.
shared="$builds/shared"
rm -rf "${shared:?}"
mkdir -p "$shared/r" "$shared/c" "$shared/l" "$shared/u"
printf '(package r (version "0.1.0") (exports a b))\n' > "$shared/r/package.sub"
printf '(require b "b.sub")\n(provide a)\n(define (a) -> i32 (+ 1 (b:b)))\n' > "$shared/r/a.sub"
printf '(provide b)\n(define (b) -> i32 1)\n' > "$shared/r/b.sub"
printf '(package c (version "0.1.0") (dependencies (r (path "../r"))))\n' > "$shared/c/package.sub"
printf '(require a r/a)\n(require b r/b)\n(define (main) (printf "~a~n" (+ (a:a) (b:b))))\n' > "$shared/c/both.sub"
both="$(bin/sub build "$shared/c/both.sub" -o "$shared/both" -c "$cache" 2>&1 && "$host" "$root/$shared/both" 2>&1)"
printf '(package r (version "0.1.0") (exports a))\n' > "$shared/r/package.sub"
narrowed="$(bin/sub build "$shared/c/both.sub" -o "$shared/both" -c "$cache" 2>&1)"
printf '(package l (version "0.1.0") (exports pull))\n' > "$shared/l/package.sub"
cp "$held/q/pull.sub" "$held/q/hidden.sub" "$shared/l/"
printf '(package u (version "0.1.0") (dependencies (l (path "../l"))))\n' > "$shared/u/package.sub"
printf '(require p l/pull)\n(p:pull)\n(define (main) (printf "~a~n" 1))\n' > "$shared/u/use.sub"
pulled="$(bin/sub build "$shared/u/use.sub" -o "$shared/use" -c "$cache" 2>&1)"
printf '(package l (version "0.1.0") (exports pull hidden))\n' > "$shared/l/package.sub"
exported="$(bin/sub build "$shared/u/use.sub" -o "$shared/use" -c "$cache" 2>&1 && "$host" "$root/$shared/use" 2>&1)"
if [ "$both" = 3 ] && [[ "$narrowed" == *'r/b is not one of the modules r exports'* ]] &&
   [[ "$pulled" == *'"hidden.sub" is not one of the modules l exports'* ]] && [ "$exported" = 1 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL a package's exports: got $both, $narrowed, $pulled and $exported"
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
# A package that needs a newer substrate than this one is refused, and sub version prints this one's, with the hash of
# substrate/.
newer="$builds/newer"
rm -rf "${newer:?}"
mkdir -p "$newer"
printf '(package newer (version "1.0.0") (substrate "99.0.0"))\n' > "$newer/package.sub"
printf '(define (main) (printf "newer~n"))\n' > "$newer/newer.sub"
refused="$(bin/sub build "$newer/newer.sub" -c "$cache" 2>&1)"
version="$(bin/sub version 2>&1)"
shape="^substrate $(cat substrate/VERSION) sha256:[0-9a-f]{64}\$"
if [ "$refused" = "sub: the package newer needs substrate 99.0.0 or newer, and this is $(cat substrate/VERSION)" ] &&
   [[ "$version" =~ $shape ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL a newer substrate, and sub version: got $refused and $version"
fi
# sub doc: a package's files, each module as its declarations would read in a header file, in its language's own forms,
# each directory as a list of its modules, the private ones below, and pages linking a type's name to where it is
# defined; a name, found through the module map of the package holding the current directory; docs/ is what make docs
# writes.
documented="$builds/documented"
rm -rf "${documented:?}"
bin/sub doc -o "$documented/text" tests/doc/sample > /dev/null 2>&1
bin/sub doc --html -o "$documented/html" tests/doc/sample > /dev/null 2>&1
printed="$(bin/sub doc std/http/cookie 2>&1)"
dependency="$(cd tests/packages/app && "$root/bin/sub" doc tools/text 2>&1 | head -1)"
outside="$(cd tests/doc/sample && "$root/bin/sub" doc sample/unused 2>&1)"
if diff -r tests/doc/expected "$documented/text" > /dev/null &&
   grep -qF '<a href="#point">point</a>' "$documented/html/sample/sample.html" &&
   grep -qF '<a href="shapes.html#shape">shape</a>' "$documented/html/sample/sample.html" &&
   grep -qF '<dt>private to</dt>' "$documented/html/sample/shapes.html" &&
   [ "$printed" = "$(cat docs/std/http/cookie.txt)" ] && [ "$dependency" = ";; tools/text" ] &&
   [ "$outside" = "sub: sample/unused is not one of the files of sample, its exports and what their source requires" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL sub doc: tests/doc/expected differs, or the pages' links, or a module printed by name: got $dependency and $outside"
  diff -r tests/doc/expected "$documented/text" | head -20
fi
bin/sub doc -o "$documented/docs" substrate std cmd packages/sqlite > /dev/null 2>&1
if diff -r docs "$documented/docs" > /dev/null; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL docs/ is not what sub doc writes: make docs writes it again"
  diff -r docs "$documented/docs" | head -20
fi
# sub doc with no arguments writes the package holding the current directory and those its module map gives, std among
# them, as HTML in its build/doc, and refuses outside packages.
packaged="$builds/packaged"
rm -rf "${packaged:?}"
mkdir -p "$packaged/loose"
cp -r tests/packages/app tests/packages/tools "$packaged/"
wrote="$(cd "$packaged/app" && "$root/bin/sub" doc 2>&1)"
unpackaged="$(cd "$packaged/loose" && "$root/bin/sub" doc 2>&1)"
if [ "$wrote" = "build/doc/index.html" ] &&
   grep -qF '<a href="tools/index.html">tools</a></td></tr><tr><td><a href="std/index.html">std</a>' \
     "$packaged/app/build/doc/index.html" &&
   grep -qF '<a href="../tools/text.html"><code>tools/text</code></a>' "$packaged/app/build/doc/app/app.html" &&
   [ "$unpackaged" = "sub: there is no package.sub in the current directory or above it" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL sub doc with no arguments: got $wrote and $unpackaged"
fi
# A test with macros builds against changed compiler sources and runs as it does here.
changed="$builds/changed"
rm -rf "${changed:?}"
mkdir -p "$changed/tests/substrate" "$changed/substrate/host"
cp -r substrate/compiler "$changed/substrate/"
cp substrate/host/fs.sub "$changed/substrate/host/"
cp tests/substrate/forms.sub "$changed/tests/substrate/"
from_changed() {
  "$host" -R -W "$root/build/compiler" "$root/$changed/substrate" build tests/substrate/forms.sub -o "$root/$changed/out" \
    -d "$root/$changed" 2>&1 && "$host" "$root/$changed/out" 2>&1
}
echo ';; changed' >> "$changed/substrate/compiler/substrate.sub"
sed -i 's|^(provide datum srcloc scope-set$|& added|; s|^(struct srcloc \[|(struct added [a i32])\n&|' \
  "$changed/substrate/compiler/syntax.sub"
if [ "$(from_changed)" = "$(cat tests/substrate/forms.out)" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL changed sources: tests/substrate/forms.sub does not build and run as it does here"
fi
sed -i 's|^(struct srcloc \[|(struct srcloc [unused i32] [|' "$changed/substrate/compiler/syntax.sub"
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
# A store entry holds just the files its hash covers: json's, not its archive's README or unused module, and nest's
# with its inner package's at their path.
json_entry="$(find tests/fetch/build/app -name json.sub -printf '%h\n' | head -1)"
nest_entry="$(find tests/fetch/build/nested -name nest.sub -printf '%h\n' | head -1)"
json_files="$(cd "$json_entry" && find . -type f | sort | tr '\n' ' ')"
nest_files="$(cd "$nest_entry" && find . -type f | sort | tr '\n' ' ')"
if [ "$json_files" = "./json.sub ./package.sub " ] &&
   [ "$nest_files" = "./inner/inner.sub ./inner/package.sub ./nest.sub ./package.sub " ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL a store entry's files: got $json_files and $nest_files"
fi
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
# sub doc fetches what a package it documents depends on, as build does.
fetched_doc="$(fetched doc -o "$root/$builds/fetch/doc" archives/outer -P build/doc)"
if [[ "$fetched_doc" == "sub: fetching http://fake/json.tar.gz" ]] &&
   grep -qx ';; requires json/json' "$builds/fetch/doc/outer/outer.txt"; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL sub doc fetching: got $fetched_doc"
fi
echo "$built modules built, $unbuilt failed"
echo "$pass passed, $fail failed; $again built again from the cache"
[ $fail -eq 0 ] && [ $unbuilt -eq 0 ]
