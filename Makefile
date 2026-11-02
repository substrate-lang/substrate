OUT ?= build

build/sub:
	@mkdir -p build && : > build/empty.sub
	bin/substrate expand build/empty.sub -c build/cache > /dev/null

check:
	tests/run.sh $(TEST_ARGS)
	$(MAKE) docs

bootstrap:
	bin/bootstrap

seed:
	bin/bootstrap seed

repl:
	cd packages/web && ../../bin/substrate site -c $(abspath build/cache) repl -o $(abspath $(OUT)/web/repl)

docs:
	rm -rf $(OUT)/doc
	bin/substrate doc --html -o $(OUT)/doc substrate std cmd packages/web packages/scheme packages/bend packages/nodes \
	  packages/sqlite

npm:
	npm/pack.sh
	npm/smoke.sh

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed repl docs npm clean
