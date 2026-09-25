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

# The compiler written in Substrate, which bin/sub runs, built by stage0.
COMPILER_SOURCES := $(wildcard compiler/*.sub lib/*.sub stage0/*.sls stage0/*.ss)

build/sub: $(COMPILER_SOURCES) build/libsubhost.so
	bin/subc build compiler/main.sub -o $@

check: build/libsubhost.so build/subhost
	tests/run.sh

# Bootstrap (spec 1.4): stage0 builds the compiler written in Substrate
# (stage1), which builds itself (stage2), which builds itself again
# (stage3). The fixpoint is stage2 = stage3, with the syntax library each
# writes the same. While stage0 is kept, stage1 = stage2 too: two
# independent compilers agree.
STAGES := build/stage1 build/stage2 build/stage3

bootstrap: build/libsubhost.so
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
	@echo "bootstrap: stage2 = stage3, and stage0 agrees (stage1 = stage2)"

clean:
	rm -rf build stage0/*.so

.PHONY: check bootstrap clean
