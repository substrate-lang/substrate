#!/usr/bin/env bash
# Installs build/substrate-lang-VERSION.tgz into a temporary prefix, then builds, runs, compiles and tests a small
# package with the commands it gives, and upgrades it from a local registry to the next version.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(cat "$root/substrate/VERSION")"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp:?}"' EXIT
export HOME="$tmp/home" npm_config_cache="$tmp/npm-cache"
unset XDG_CACHE_HOME SUBSTRATE_CACHE SUBSTRATE_PACKAGES
npm install --global --prefix "$tmp/prefix" --no-audit --no-fund --silent "$root/build/substrate-lang-$version.tgz"
export PATH="$tmp/prefix/bin:$PATH"
check() { # name expected actual
  if [ "$2" != "$3" ]; then printf 'npm smoke: %s gave\n%s\nnot\n%s\n' "$1" "$3" "$2"; exit 1; fi
}
check "substrate version" "substrate $version" "$(substrate version | cut -d' ' -f1-2)"
check "sub version" "substrate $version" "$(sub version | cut -d' ' -f1-2)"
mkdir -p "$tmp/hello/tests"
cd "$tmp/hello"
printf '(package hello (version "0.1.0"))\n' > package.sub
printf '(require-unqualified b64 std/encoding/base64)\n(provide greeting)\n(define (greeting) -> string "hi")\n(define (main) (let ([b (make-buffer)]) (base64-encode! (& b) (cast (slice u8) (greeting))) (printf "~a~n" (buffer-string (& b)))))\n' > hello.sub
printf '(require-unqualified hello hello)\n(test greets (expect-equal (greeting) "hi"))\n' > tests/hello.sub
check "substrate run" "aGk=" "$(substrate run hello.sub)"
substrate build hello.sub -o out > /dev/null
check "substrate run DIR" "aGk=" "$(substrate run out)"
substrate map hello.sub > hello.map
substrate compile hello.sub -m hello.map -o compiled
check "substrate compile" "aGk=" "$(substrate run compiled)"
check "substrate test" "hello: 1 passed" "$(substrate test | tail -1 | sed 's/ (.*//')"
check "the user's cache" "yes" "$([ -d "$HOME/.cache/substrate/$version" ] && echo yes || echo no)"
next="$(echo "$version" | awk -F. '{ print $1 "." $2 "." $3 + 1 }')"
mkdir -p "$tmp/registry"
cp -r "$root/build/npm" "$tmp/next"
printf '%s\n' "$next" > "$tmp/next/substrate/VERSION"
node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
           fs.writeFileSync(process.argv[1], JSON.stringify({ ...p, version: process.argv[2] }));' "$tmp/next/package.json" "$next"
(cd "$tmp/next" && npm pack --silent --pack-destination "$tmp/registry" > /dev/null)
cat > "$tmp/registry.mjs" <<'END'
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
const [dir, version] = process.argv.slice(2);
const tarball = `substrate-lang-${version}.tgz`;
const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(`${dir}/${tarball}`)).digest('base64');
const server = http.createServer((q, a) => {
  const { port } = server.address();
  if (q.url === '/substrate-lang') {
    a.end(JSON.stringify({ 'dist-tags': { latest: version },
      versions: { [version]: { dist: { tarball: `http://127.0.0.1:${port}/${tarball}`, integrity } } } }));
  } else if (q.url === `/${tarball}`) {
    a.end(fs.readFileSync(`${dir}/${tarball}`));
  } else {
    a.statusCode = 404;
    a.end();
  }
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
END
node "$tmp/registry.mjs" "$tmp/registry" "$next" > "$tmp/port" &
registry=$!
trap 'kill "$registry" 2> /dev/null; rm -rf "${tmp:?}"' EXIT
for _ in $(seq 50); do [ -s "$tmp/port" ] && break; sleep 0.1; done
export SUBSTRATE_REGISTRY="http://127.0.0.1:$(cat "$tmp/port")"
check "substrate upgrade" "substrate $next is installed in $HOME/.substrate/toolchains/$next" "$(substrate upgrade)"
check "the upgraded version" "substrate $next" "$(substrate version | cut -d' ' -f1-2)"
check "substrate run, upgraded" "aGk=" "$(substrate run hello.sub)"
check "substrate upgrade, again" "substrate $next is the newest" "$(substrate upgrade)"
echo "npm smoke: substrate-lang $version installs, works and upgrades to $next"
