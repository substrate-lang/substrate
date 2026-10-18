// Recursive fib: calls and integer arithmetic.
#include "bench.h"

static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

BENCH(fib(38))
