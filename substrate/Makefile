# Run inside the dev shell: nix develop -c make check
CFLAGS ?= -O2 -g -Wall -Wextra -Wno-unused-parameter

build/subhost: host/subhost.c
	@mkdir -p build
	$(CC) $(CFLAGS) -I$(WASMTIME_INCLUDE) -o $@ host/subhost.c \
	  -L$(WASMTIME_LIB) -lwasmtime -Wl,-rpath,$(WASMTIME_LIB)

# The compiler that bin/sub runs (spec 1.4). bin/sub builds build/sub
# itself when the compiler's sources or the seed are newer than it: the
# seed builds the sources into build/sub-1, which builds them again. The
# cache (spec 3.7) is keyed by the compiler's build, so a new compiler
# does not use modules an older one compiled.
build/sub: build/subhost
	@mkdir -p build && : > build/empty.sub
	bin/sub expand build/empty.sub > /dev/null

# The tests, built by bin/sub and run on build/subhost.
check: build/subhost
	tests/run.sh

# The fixpoint (spec 1.4): build/sub must build itself into the same
# bytes.
bootstrap: build/subhost
	bin/bootstrap

# Make build/sub the seed, once it builds itself.
seed: build/subhost
	bin/bootstrap seed

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed clean
