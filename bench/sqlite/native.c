/* native SCRIPT DATABASE: speedtest1's script on SQLite, as speed.sub runs it on lib/sqlite: from each "-- begin test"
   line to the next in one sqlite3_exec, printed as its time in ms and the line's test. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "sqlite3.h"

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

int main(int argc, char **argv) {
  static const char mark[] = "-- begin test ";
  FILE *f;
  long n;
  char *text, *at, *next, *err;
  sqlite3 *db;
  int failed = 0;
  if (argc != 3) {
    fprintf(stderr, "usage: %s SCRIPT DATABASE\n", argv[0]);
    return 64;
  }
  f = fopen(argv[1], "rb");
  if (f == 0 || fseek(f, 0, SEEK_END) != 0 || (n = ftell(f)) < 0 || fseek(f, 0, SEEK_SET) != 0) {
    fprintf(stderr, "cannot read %s\n", argv[1]);
    return 1;
  }
  text = malloc(n + 1);
  if (fread(text, 1, n, f) != (size_t)n) return 1;
  text[n] = 0;
  fclose(f);
  if (sqlite3_open(argv[2], &db) != SQLITE_OK) {
    fprintf(stderr, "%s\n", sqlite3_errmsg(db));
    return 1;
  }
  for (at = text; at != 0; at = next) {
    char saved = 0;
    double t;
    next = strstr(at + 1, "\n-- begin test ");
    if (next != 0) {
      next++;
      saved = *next;
      *next = 0;
    }
    t = now();
    if (sqlite3_exec(db, at, 0, 0, &err) != SQLITE_OK) {
      fprintf(stderr, "%.*s: %s\n", (int)strcspn(at, "\n"), at, err);
      failed = 1;
    }
    t = now() - t;
    if (strncmp(at, mark, sizeof mark - 1) == 0) {
      printf("%.3f %.*s\n", t, (int)strcspn(at + sizeof mark - 1, "\n"), at + sizeof mark - 1);
    }
    if (next != 0) *next = saved;
  }
  sqlite3_close(db);
  return failed;
}
