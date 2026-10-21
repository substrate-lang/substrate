// 10 million calls, a tenth of which fail, reported by a result the caller tests.
#include "bench.h"

static int check(int i, int *failed) {
  if (i % 10 == 0) { *failed = 1; return i; }
  return i;
}

static int64_t bench(void) {
  int64_t sum = 0;
  for (int i = 0; i < 10000000; i++) {
    int failed = 0, v = check(i, &failed);
    sum += failed ? -v : v;
  }
  return sum;
}

BENCH(bench())
