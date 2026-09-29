// The primes below 100 million, by the sieve of Eratosthenes: a byte
// array from calloc, and loops over it.
#include "bench.h"

static uint32_t sieve(uint32_t n) {
  uint8_t *composite = kr_calloc(n, 1);
  uint32_t count = 0;
  for (uint32_t i = 2; i < n; i++)
    if (composite[i] == 0) {
      count++;
      for (uint64_t j = (uint64_t)i * i; j < n; j += i) composite[j] = 1;
    }
  kr_free(composite);
  return count;
}

BENCH(sieve(100000000))
