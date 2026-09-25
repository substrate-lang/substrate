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

check: build/libsubhost.so build/subhost
	tests/run.sh

clean:
	rm -rf build stage0/*.so

.PHONY: check clean
