OUT ?= build

build/sub:
	@mkdir -p build && : > build/empty.sub
	bin/sub expand build/empty.sub > /dev/null

check:
	tests/run.sh

bootstrap:
	bin/bootstrap

seed:
	bin/bootstrap seed

repl:
	bin/sub site $(OUT)/web/repl std/web/repl/repl.sub -p std/web/repl/page.html \
	  -f files $(addprefix compiler/,macros.sub substrate.sub syntax.sub wasm.sub writer.sub) \
	  $(shell find host std/languages/scheme std/languages/bend -name '*.sub' | sort) std/languages/nodes.sub std/encoding/utf8.sub

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed repl clean
