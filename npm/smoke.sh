#!/usr/bin/env bash
# Installs build/substrate-lang-VERSION.tgz into a temporary prefix, then builds, runs, compiles and tests a small
# package with the substrate and sub commands it gives.
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
echo "npm smoke: substrate-lang $version installs and works"
