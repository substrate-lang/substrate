// A product of 500 by 500 matrices of f64: pointer arithmetic over
// arrays, and float loops.
#include "bench.h"

static void matmul(int n, double *a, double *b, double *c) {
  for (int i = 0; i < n; i++)
    for (int k = 0; k < n; k++) {
      double aik = a[i * n + k], *bk = b + k * n, *ci = c + i * n;
      for (int j = 0; j < n; j++) ci[j] += aik * bk[j];
    }
}

static int64_t bench(void) {
  int n = 500;
  double *a = kr_malloc(n * n * sizeof(double)), *b = kr_malloc(n * n * sizeof(double));
  double *c = kr_calloc(n * n, sizeof(double)), sum = 0.0;
  for (int i = 0; i < n; i++)
    for (int j = 0; j < n; j++) { a[i * n + j] = (i + j) % 10; b[i * n + j] = (i * j) % 10; }
  matmul(n, a, b, c);
  for (int i = 0; i < n * n; i++) sum += c[i];
  return (int64_t)sum;
}

BENCH(bench())
