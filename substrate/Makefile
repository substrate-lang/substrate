build/sub:
	@mkdir -p build && : > build/empty.sub
	bin/sub expand build/empty.sub > /dev/null

check:
	tests/run.sh

bootstrap:
	bin/bootstrap

seed:
	bin/bootstrap seed

clean:
	rm -rf build

.PHONY: build/sub check bootstrap seed clean
