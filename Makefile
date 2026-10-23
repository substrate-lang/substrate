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
	bin/sub site $(OUT)/web/repl lib/web/repl/repl.sub -p lib/web/repl/page.html -w session lib/web/repl/session.sub \
	  -f files compiler host lib/nodes.sub lib/scheme lib/bend

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed repl clean
