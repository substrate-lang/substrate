// The Mandelbrot set on a 600 by 600 grid, at most 100 iterations a
// point, with complex numbers as structs passed and returned by value.
#include "bench.h"

typedef struct { double re, im; } complex_t;

static complex_t make(double re, double im) { complex_t z; z.re = re; z.im = im; return z; }

static complex_t add(complex_t a, complex_t b) { return make(a.re + b.re, a.im + b.im); }

static complex_t mul(complex_t a, complex_t b) {
  return make(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}

static double magnitude2(complex_t a) { return a.re * a.re + a.im * a.im; }

// How many points stay within 2 of 0 for limit iterations of z^2 + c.
static int mandelbrot(int size, int limit) {
  int inside = 0;
  for (int y = 0; y < size; y++)
    for (int x = 0; x < size; x++) {
      complex_t c = make(3.0 * x / size - 2.0, 3.0 * y / size - 1.5), z = make(0.0, 0.0);
      int k = 0;
      while (k < limit && magnitude2(z) <= 4.0) { z = add(mul(z, z), c); k++; }
      if (k == limit) inside++;
    }
  return inside;
}

BENCH(mandelbrot(600, 100))
