/* Lifecycle: permanent. After bootstrap it runs the compiler. */
/* subhost DIR [arg ...]: run the program subc build wrote to DIR (spec
 * section 4). DIR/program names the program's linklets, one per line, in
 * the order they are instantiated, each after those it imports from; the
 * last is the program's own. Each is instantiated from DIR/<name>.wasm
 * under its name, then the last one's main is called with the arguments.
 *
 * Exit status: 0 when main returns, 1 when the program cannot be loaded, 2
 * when it traps (the message goes to stderr, as subc run writes it), and
 * whatever the program passes to host.exit. */
#include "subhost.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The whole file at path, or NULL; its length in *len. */
static char *read_all(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  char *buf = NULL;
  long size = -1;
  if (fseek(f, 0, SEEK_END) == 0) size = ftell(f);
  if (size >= 0 && fseek(f, 0, SEEK_SET) == 0) {
    buf = malloc((size_t)size + 1);
    if (fread(buf, 1, (size_t)size, f) == (size_t)size) {
      buf[size] = '\0';
      *len = (size_t)size;
    } else {
      free(buf);
      buf = NULL;
    }
  }
  fclose(f);
  return buf;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: subhost DIR [arg ...]\n");
    return 64;
  }
  const char *dir = argv[1];
  char path[4096];
  size_t len;
  snprintf(path, sizeof path, "%s/program", dir);
  char *program = read_all(path, &len);
  if (!program) {
    fprintf(stderr, "subhost: cannot read %s\n", path);
    return 1;
  }
  sub_host *h = sub_host_new();
  for (int i = 2; i < argc; i++) sub_add_arg(h, argv[i]);
  const char *last = NULL;
  for (char *name = strtok(program, "\n"); name; name = strtok(NULL, "\n")) {
    snprintf(path, sizeof path, "%s/%s.wasm", dir, name);
    char *bytes = read_all(path, &len);
    if (!bytes) {
      fprintf(stderr, "subhost: cannot read %s\n", path);
      return 1;
    }
    int rc = sub_instantiate(h, name, (const uint8_t *)bytes, len);
    free(bytes);
    if (rc) {
      fprintf(stderr, "error: %s\n", sub_last_error(h));
      return 2;
    }
    last = name;
  }
  if (!last) {
    fprintf(stderr, "subhost: %s names no linklets\n", path);
    return 1;
  }
  if (sub_call(h, last, "main", 0, 0, 0, 0, 0, 0, 0)) {
    const char *err = sub_last_error(h);
    /* A program without main has nothing to run, as for subc run. */
    if (strncmp(err, "call: no function", 17) == 0) return 0;
    fprintf(stderr, "error: %s\n", err);
    return 2;
  }
  return 0;
}
