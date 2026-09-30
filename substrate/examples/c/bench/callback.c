// A sum and a count over 10 million integers, 10 times, each item given
// to a callback: a function pointer and a pointer to its caller's
// variables, as C passes a closure.
#include "bench.h"

static void each(int *a, int n, void (*f)(void *, int), void *context) {
  for (int i = 0; i < n; i++) f(context, a[i]);
}

static void add_to(void *context, int x) { *(int64_t *)context += x; }

static int64_t sum(int *a, int n) {
  int64_t total = 0;
  each(a, n, add_to, &total);
  return total;
}

typedef struct { int64_t count; int limit; } counter;

static void count_one(void *context, int x) {
  counter *c = context;
  if (x > c->limit) c->count++;
}

static int64_t count_above(int *a, int n, int limit) {
  counter c = {0, limit};
  each(a, n, count_one, &c);
  return c.count;
}

static int64_t bench(void) {
  int n = 10000000, *a = kr_malloc(n * sizeof(int));
  int64_t result = 0;
  for (int i = 0; i < n; i++) a[i] = (i * 7) % 1000;
  for (int k = 0; k < 10; k++) { result += sum(a, n); result += count_above(a, n, k * 100); }
  return result;
}

BENCH(bench())
