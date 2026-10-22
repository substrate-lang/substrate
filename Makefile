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
	host/web/site.sh $(OUT)/web/repl lib/web/repl/repl.sub -p lib/web/repl/page.html -g session lib/web/repl/session.sub \
	  -f files compiler/substrate.sub compiler/wasm.sub compiler/writer.sub compiler/syntax.sub compiler/macros.sub \
	  host/host.sub host/fs.sub lib/nodes.sub lib/scheme lib/bend

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed repl clean
