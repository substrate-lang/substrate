// A random tree of expressions, tagged unions in an arena, evaluated by switch.
#include "bench.h"

typedef struct expr {
  uint32_t tag;
  union { uint32_t n; struct { struct expr *a, *b; } two; };
} expr;
enum { NUM, ADD, MUL, NEG };

static expr *build(arena *a, int depth, uint32_t seed) {
  expr *e = arena_alloc(a, sizeof(expr));
  uint32_t next = seed * 1103515245 + 12345;
  if (depth == 0) { e->tag = NUM; e->n = seed >> 16; }
  else {
    uint32_t k = (seed >> 16) % 3;
    if (k == 0) { e->tag = ADD; e->two.a = build(a, depth - 1, next); e->two.b = build(a, depth - 1, next + 1); }
    else if (k == 1) { e->tag = MUL; e->two.a = build(a, depth - 1, next); e->two.b = build(a, depth - 1, next + 1); }
    else { e->tag = NEG; e->two.a = build(a, depth - 1, next); }
  }
  return e;
}

static uint32_t eval(expr *e, uint32_t k) {
  switch (e->tag) {
    case NUM: return e->n + k;
    case ADD: return eval(e->two.a, k) + eval(e->two.b, k);
    case MUL: return eval(e->two.a, k) * eval(e->two.b, k);
    default: return 0 - eval(e->two.a, k);
  }
}

static int64_t bench(void) {
  arena a = {0};
  uint64_t sum = 0;
  expr *tree = build(&a, 21, 1);
  for (int i = 0; i < 400; i++) sum += eval(tree, i);
  arena_free(&a);
  return (int64_t)sum;
}

BENCH(bench())
