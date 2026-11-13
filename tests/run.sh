#!/usr/bin/env bash
# The tests make check runs.
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

# The packages' tests, given every grant.
packages=(./std ./cmd ./tests ./tests/web ./examples/testing)
if bin/substrate test -c "$cache" -A "$@" "${packages[@]}"; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL sub test"
fi
# Each package's test program, built again from the cache, is the same.
again=0
for p in "${packages[@]}"; do
  first="$builds/again/$p"
  rm -rf "${first:?}"
  mkdir -p "$(dirname "$first")"
  cp -r "$p/build/test/program" "$first"
  if bin/substrate test -c "$cache" --no-run "$p" > /dev/null 2>&1 && same_program "$p/build/test/program" "$first"; then
    again=$((again + 1))
  else
    fail=$((fail + 1))
    echo "FAIL $p: its test program, built again from the cache, differs"
  fi
done
# Each module of bench and substrate/host builds, and so do each one-file package and the proxy tests' server.
one_file() { awk 'NF && !/^[[:space:]]*;/ { found = 1; code = !/^[[:space:]]*\(package([[:space:]]|$)/; exit } END { exit found ? code : 1 }' "$1"; }
mapfile -t modules < <( (find bench substrate/host -name '*.sub' -not -name package.sub -not -path '*/build/*'
                         find cmd std tests/web -name '*.sub' -not -name package.sub -not -path '*/build/*' \
                           -not -path '*/tests/*' | while read -r f; do if one_file "$f"; then echo "$f"; fi; done) | sort)
for m in "${modules[@]}" proxy; do
  if [ "$m" = proxy ]; then
    actual="$(cd tests && "$root/bin/substrate" build proxy -c "$cache" 2>&1)"
  else
    actual="$(cd "$(dirname "$m")" && "$root/bin/substrate" build "$(basename "$m")" -o "$root/$builds/modules/${m%.sub}" -c "$cache" 2>&1)"
  fi
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
    (cd tests && "$root/bin/substrate" build servers -c "$cache")
    "$host" --grant net 127.0.0.1 --grant read "$root/tests/events/files" "$root/tests/build/programs/servers" \
      "$root/tests/events/files" \
      > "$builds/servers.url" & server=$!
    for i in $(seq 50); do [ -s "$builds/servers.url" ] && break; sleep 0.1; done
    url="$(cat "$builds/servers.url")"
  fi
  actual="$(cd tests && "$root/bin/substrate" build "$name" -c "$cache" 2>&1 \
              && timeout 60 "$host" --grant net 127.0.0.1 --grant read events "$root/tests/build/programs/$name" "$url" \
                            "ws${url#http}" 2>&1)"
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

echo "$built modules built, $unbuilt failed"
echo "$pass passed, $fail failed; $again built again from the cache"
[ $fail -eq 0 ] && [ $unbuilt -eq 0 ]
