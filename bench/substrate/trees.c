// Binary trees, as the Benchmarks Game's: made, walked and freed.
#include "bench.h"

typedef struct node { struct node *left, *right; } node;

static node *make(int depth) {
  node *n = kr_malloc(sizeof(node));
  if (depth == 0) n->left = n->right = 0;
  else { n->left = make(depth - 1); n->right = make(depth - 1); }
  return n;
}

static int check(node *n) { return n->left == 0 ? 1 : 1 + check(n->left) + check(n->right); }

static void release(node *n) {
  if (n->left) { release(n->left); release(n->right); }
  kr_free(n);
}

static int64_t bench(void) {
  int64_t total = 0;
  int max_depth = 16;
  for (int d = 4; d <= max_depth; d += 2)
    for (int k = 0; k < 1 << (max_depth - d + 4); k++) {
      node *t = make(d);
      total += check(t);
      release(t);
    }
  return total;
}

BENCH(bench())
