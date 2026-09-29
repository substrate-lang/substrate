// Quicksort of 5 million integers, comparing through a function pointer,
// as qsort does.
#include "bench.h"

static int less(int a, int b) { return a < b; }

static void quicksort(int *a, int lo, int hi, int (*before)(int, int)) {
  while (lo < hi) {
    int pivot = a[lo + (hi - lo) / 2], i = lo, j = hi;
    while (i <= j) {
      while (before(a[i], pivot)) i++;
      while (before(pivot, a[j])) j--;
      if (i <= j) { int t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    // The smaller part by recursion, the larger by the loop.
    if (j - lo < hi - i) { quicksort(a, lo, j, before); lo = i; }
    else { quicksort(a, i, hi, before); hi = j; }
  }
}

static int64_t bench(void) {
  int n = 5000000, *a = kr_malloc(n * sizeof(int));
  uint32_t x = 1;
  int64_t sum = 0;
  for (int i = 0; i < n; i++) { x = x * 1103515245 + 12345; a[i] = (int)(x >> 1); }
  quicksort(a, 0, n - 1, less);
  for (int i = 1; i < n; i++) {
    if (a[i - 1] > a[i]) { sum = -1; break; }
    sum += (int64_t)a[i] * (i % 7);
  }
  return sum;
}

BENCH(bench())
