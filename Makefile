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
	bin/sub site $(OUT)/web/repl lib/web/repl/repl.sub -p lib/web/repl/page.html \
	  -f files $(addprefix compiler/,macros.sub substrate.sub syntax.sub wasm.sub writer.sub) \
	  $(shell find host lib/languages/scheme lib/languages/bend -name '*.sub' | sort) lib/languages/nodes.sub

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed repl clean
