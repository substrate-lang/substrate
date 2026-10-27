// zlib on the phases compress.sub times, reported the same way. With OUT not "-", each output is written there as
// zlib-NAME-LEVEL.deflate, and ours there inflated and checked; with REPS 0 it only checks.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "zlib.h"

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static unsigned char *slurp(const char *path, size_t *n) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  *n = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *b = malloc(*n + 1);
  if (fread(b, 1, *n, f) != *n) *n = 0;
  fclose(f);
  return b;
}

static const char *base(const char *path) {
  const char *s = strrchr(path, '/');
  return s ? s + 1 : path;
}

static int inflated(const unsigned char *packed, size_t size, unsigned char *out, size_t n) {
  z_stream s = {0};
  inflateInit2(&s, -15);
  s.next_in = (unsigned char *) packed;
  s.avail_in = size;
  s.next_out = out;
  s.avail_out = n;
  int r = inflate(&s, Z_FINISH);
  size_t got = s.total_out;
  inflateEnd(&s);
  return r == Z_STREAM_END && got == n;
}

int main(int argc, char **argv) {
  int reps = atoi(argv[1]);
  const char *dir = argv[2];
  int levels[3] = {1, 6, 9};
  char name[4096];
  for (int a = 3; a < argc; a++) {
    size_t n = 0;
    unsigned char *data = slurp(argv[a], &n);
    if (!data) {
      fprintf(stderr, "zlib: cannot read %s\n", argv[a]);
      return 1;
    }
    size_t cap = n + n / 100 + 1024;
    unsigned char *packed = malloc(cap), *out = malloc(n + 1);
    printf("%s %zu", base(argv[a]), n);
    for (int k = 0; k < 3; k++) {
      int level = levels[k];
      if (reps > 0) {
        double best = 1e9, t;
        size_t size = 0;
        for (int r = 0; r < reps; r++) {
          z_stream s = {0};
          deflateInit2(&s, level, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY);
          s.next_in = data;
          s.avail_in = n;
          s.next_out = packed;
          s.avail_out = cap;
          t = now();
          deflate(&s, Z_FINISH);
          t = now() - t;
          size = s.total_out;
          deflateEnd(&s);
          if (t < best) best = t;
        }
        printf(" d%d %f %zu", level, best, size);
        if (strcmp(dir, "-") != 0) {
          snprintf(name, sizeof name, "%s/zlib-%s-%d.deflate", dir, base(argv[a]), level);
          FILE *f = fopen(name, "wb");
          fwrite(packed, 1, size, f);
          fclose(f);
        }
        if (level == 6) {
          int same = 0;
          best = 1e9;
          for (int r = 0; r < reps; r++) {
            t = now();
            same = inflated(packed, size, out, n);
            t = now() - t;
            if (t < best) best = t;
          }
          printf(" i6 %f %s", best, same && memcmp(out, data, n) == 0 ? "same" : "differs");
        }
      }
      if (strcmp(dir, "-") != 0) {
        size_t size;
        snprintf(name, sizeof name, "%s/ours-%s-%d.deflate", dir, base(argv[a]), level);
        unsigned char *theirs = slurp(name, &size);
        if (theirs) {
          printf(" x%d %s", level, inflated(theirs, size, out, n) && memcmp(out, data, n) == 0 ? "ok" : "bad");
          free(theirs);
        }
      }
    }
    printf("\n");
    free(data);
    free(packed);
    free(out);
  }
  return 0;
}
