OUT ?= build

build/sub:
	@mkdir -p build && : > build/empty.sub
	bin/sub expand build/empty.sub -c build/cache > /dev/null

check:
	tests/run.sh

bootstrap:
	bin/bootstrap

seed:
	bin/bootstrap seed

repl:
	bin/sub site -c build/cache $(OUT)/web/repl std/web/repl/repl.sub -p std/web/repl/page.html \
	  -f files $(addprefix compiler/,macros.sub substrate.sub syntax.sub wasm.sub writer.sub) \
	  $(shell find host std/languages/scheme std/languages/bend -name '*.sub' | sort) std/languages/nodes.sub std/encoding/utf8.sub

docs:
	rm -rf docs
	bin/sub doc -o docs std compiler host cmd packages/sqlite

html:
	bin/sub doc --html -o $(OUT)/doc std compiler host cmd packages/sqlite

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed repl docs html clean
