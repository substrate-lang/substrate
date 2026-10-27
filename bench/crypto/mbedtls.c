// mbedTLS on the phases crypto.sub times, reported the same way.
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "mbedtls/md.h"
#include "mbedtls/pkcs5.h"
#include "mbedtls/sha256.h"

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static void check(const char *phase, double best, const unsigned char *b) {
  printf("%s %f %02x%02x%02x%02x\n", phase, best, b[0], b[1], b[2], b[3]);
}

int main(int argc, char **argv) {
  int reps = atoi(argv[1]);
  size_t n = 16777216;
  unsigned char *data = malloc(n), out[32], key[32];
  const mbedtls_md_info_t *sha256 = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  double best = 1e9, t;
  for (size_t i = 0; i < n; i++) data[i] = i % 251;
  for (int i = 0; i < 32; i++) key[i] = i;
  for (int r = 0; r < reps; r++) {
    t = now();
    mbedtls_sha256(data, n, out, 0);
    t = now() - t;
    if (t < best) best = t;
  }
  check("sha256", best, out);
  best = 1e9;
  for (int r = 0; r < reps; r++) {
    t = now();
    for (int i = 0; i < 100000; i++) mbedtls_md_hmac(sha256, key, 32, data + i, 100, out);
    t = now() - t;
    if (t < best) best = t;
  }
  check("hmac", best, out);
  best = 1e9;
  for (int r = 0; r < reps; r++) {
    t = now();
    mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256, (const unsigned char *) "correct horse battery staple", 28,
                                  key, 16, 600000, 32, out);
    t = now() - t;
    if (t < best) best = t;
  }
  check("pbkdf2", best, out);
  return 0;
}
