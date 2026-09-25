# Run inside the dev shell: nix develop -c make check
CFLAGS ?= -O2 -g -Wall -Wextra -Wno-unused-parameter

build/libsubhost.so: host/subhost.c host/subhost.h
	@mkdir -p build
	$(CC) $(CFLAGS) -shared -fPIC -I$(WASMTIME_INCLUDE) -o $@ host/subhost.c \
	  -L$(WASMTIME_LIB) -lwasmtime -Wl,-rpath,$(WASMTIME_LIB)

build/subhost: host/main.c host/subhost.c host/subhost.h
	@mkdir -p build
	$(CC) $(CFLAGS) -I$(WASMTIME_INCLUDE) -o $@ host/main.c host/subhost.c \
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

# The tests, built by stage0, while it is kept.
check-stage0: build/libsubhost.so build/subhost
	COMPILER=bin/subc tests/run.sh

# Bootstrap from stage0 (spec 1.4): stage0 builds the compiler (stage1),
# which builds itself (stage2), which builds itself again (stage3). The
# fixpoint is stage2 = stage3, with the syntax library each writes the
# same. Stage0 agrees if stage1 = stage2, and the seed if build/sub =
# stage3.
STAGES := build/stage1 build/stage2 build/stage3

bootstrap: build/libsubhost.so build/sub
	rm -rf $(STAGES) build/stage*-syntax.wasm
	mkdir -p $(STAGES)
	bin/subc build compiler/main.sub -o build/stage1
	bin/subc syntax-library -o build/stage1-syntax.wasm
	host/subhost.mjs build/stage1 $(CURDIR) build compiler/main.sub -o build/stage2
	host/subhost.mjs build/stage1 $(CURDIR) syntax-library -o build/stage2-syntax.wasm
	host/subhost.mjs build/stage2 $(CURDIR) build compiler/main.sub -o build/stage3
	host/subhost.mjs build/stage2 $(CURDIR) syntax-library -o build/stage3-syntax.wasm
	diff -r build/stage2 build/stage3
	cmp build/stage2-syntax.wasm build/stage3-syntax.wasm
	diff -r build/stage1 build/stage2
	cmp build/stage1-syntax.wasm build/stage2-syntax.wasm
	diff -r build/stage3 build/sub
	@echo "bootstrap: stage2 = stage3; stage0 agrees (stage1 = stage2), and so does the seed (build/sub = stage3)"

# Make build/sub the seed, once it builds itself.
seed: build/sub
	rm -rf build/sub-check
	mkdir -p build/sub-check
	host/subhost.mjs build/sub $(CURDIR) build compiler/main.sub -o build/sub-check
	diff -r build/sub build/sub-check
	rm -rf seed
	cp -r build/sub seed

clean:
	rm -rf build stage0/*.so

.PHONY: check check-stage0 bootstrap seed clean
