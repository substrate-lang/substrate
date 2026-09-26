# Run inside the dev shell: nix develop -c make check
CFLAGS ?= -O2 -g -Wall -Wextra -Wno-unused-parameter

build/subhost: host/subhost.c
	@mkdir -p build
	$(CC) $(CFLAGS) -I$(WASMTIME_INCLUDE) -o $@ host/subhost.c \
	  -L$(WASMTIME_LIB) -lwasmtime -Wl,-rpath,$(WASMTIME_LIB)

# The compiler bin/sub runs (spec 1.4). The seed, a build of the compiler
# by itself, checked in, builds the compiler's source (build/sub-1), which
# builds it again: build/sub is the source compiled by itself.
COMPILER_SOURCES := $(wildcard compiler/*.sub lib/*.sub)

build/sub: $(COMPILER_SOURCES) seed/program
	rm -rf build/sub-1 build/sub
	mkdir -p build/sub-1 build/sub
	host/subhost.mjs seed $(CURDIR) build compiler/main.sub -o build/sub-1
	host/subhost.mjs build/sub-1 $(CURDIR) build compiler/main.sub -o build/sub

# The tests, built by build/sub and run on build/subhost.
check: build/subhost build/sub
	tests/run.sh

# The fixpoint (spec 1.4): build/sub builds itself again into the same
# bytes.
bootstrap: build/sub
	rm -rf build/sub-2
	mkdir -p build/sub-2
	host/subhost.mjs build/sub $(CURDIR) build compiler/main.sub -o build/sub-2
	diff -r build/sub build/sub-2
	@echo "bootstrap: build/sub builds itself"

# Make build/sub the seed, once it builds itself.
seed: bootstrap
	rm -rf seed
	cp -r build/sub seed

clean:
	rm -rf build

.PHONY: check bootstrap seed clean
