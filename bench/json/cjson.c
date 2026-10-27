// cJSON on each file: the best of N runs of each phase in ms, as json.sub reports ours.
#include "cJSON.c"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static double sum(const cJSON *v) {
  double s = 1;
  if (cJSON_IsNumber(v)) s += v->valuedouble;
  if (cJSON_IsString(v)) s += strlen(v->valuestring);
  for (const cJSON *c = v->child; c; c = c->next) s += sum(c);
  return s;
}

int main(int argc, char **argv) {
  int reps = atoi(argv[1]);
  for (int i = 2; i < argc; i++) {
    FILE *f = fopen(argv[i], "rb");
    if (!f) { perror(argv[i]); return 1; }
    fseek(f, 0, SEEK_END);
    size_t n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *text = malloc(n);
    if (fread(text, 1, n, f) != n) return 1;
    fclose(f);
    double parse = 1e9, write = 1e9, indented = 1e9;
    size_t written = 0, indented_length = 0;
    for (int r = 0; r < reps; r++) {
      double t = now();
      cJSON_Delete(cJSON_ParseWithLength(text, n));
      t = now() - t;
      if (t < parse) parse = t;
    }
    cJSON *v = cJSON_ParseWithLength(text, n);
    for (int r = 0; r < reps; r++) {
      double t = now();
      char *out = cJSON_PrintUnformatted(v);
      t = now() - t;
      if (t < write) write = t;
      written = strlen(out);
      free(out);
    }
    for (int r = 0; r < reps; r++) {
      double t = now();
      char *out = cJSON_Print(v);
      t = now() - t;
      if (t < indented) indented = t;
      indented_length = strlen(out);
      free(out);
    }
    const char *name = strrchr(argv[i], '/');
    printf("%s sum %.17g parse %.3f write %.3f %zu indented %.3f %zu\n", name ? name + 1 : argv[i], sum(v), parse, write,
           written, indented, indented_length);
    cJSON_Delete(v);
    free(text);
  }
  return 0;
}
