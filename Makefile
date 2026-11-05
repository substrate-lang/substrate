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

docs:
	rm -rf $(OUT)/doc
	bin/substrate doc --html -o $(OUT)/doc substrate std cmd

npm:
	npm/pack.sh
	npm/smoke.sh

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed docs npm clean
