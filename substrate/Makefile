CFLAGS ?= -O2 -g -Wall -Wextra -Wno-unused-parameter

build/subhost: host/subhost.c
	@mkdir -p build
	$(CC) $(CFLAGS) -I$(WASMTIME_INCLUDE) -o $@ host/subhost.c \
	  -L$(WASMTIME_LIB) -lwasmtime -Wl,-rpath,$(WASMTIME_LIB)

# bin/sub builds build/sub when the compiler's sources or the seed are newer.
build/sub: build/subhost
	@mkdir -p build && : > build/empty.sub
	bin/sub expand build/empty.sub > /dev/null

check: build/subhost
	tests/run.sh

bootstrap: build/subhost
	bin/bootstrap

seed: build/subhost
	bin/bootstrap seed

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed clean
