OUT ?= build

build/sub:
	@mkdir -p build && : > build/empty.sub
	bin/substrate expand build/empty.sub -c build/cache > /dev/null

check:
	tests/run.sh
	$(MAKE) docs

bootstrap:
	bin/bootstrap

seed:
	bin/bootstrap seed

repl:
	bin/substrate site -c build/cache $(OUT)/web/repl packages/web/repl/repl.sub -p packages/web/repl/page.html \
	  -f files $(addprefix substrate/compiler/,macros.sub substrate.sub syntax.sub wasm.sub writer.sub) \
	  $(shell find substrate/host packages/scheme packages/bend -name '*.sub' | sort) packages/nodes/nodes.sub std/encoding/utf8.sub

docs:
	rm -rf $(OUT)/doc
	bin/substrate doc --html -o $(OUT)/doc substrate std cmd packages/web packages/scheme packages/bend packages/nodes \
	  packages/sqlite

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed repl docs clean
