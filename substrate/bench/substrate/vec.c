// An array that grows, for i32 and for a struct: 10 million items pushed and summed.
#include "bench.h"

typedef struct { int x, y; } point;
typedef struct { int *items; uint32_t count, capacity; } ints;
typedef struct { point *items; uint32_t count, capacity; } points;

static void push_int(ints *v, int x) {
  if (v->count == v->capacity) {
    v->capacity = v->capacity == 0 ? 16 : 2 * v->capacity;
    v->items = kr_realloc(v->items, v->capacity * sizeof(int));
  }
  v->items[v->count++] = x;
}

static void push_point(points *v, point x) {
  if (v->count == v->capacity) {
    v->capacity = v->capacity == 0 ? 16 : 2 * v->capacity;
    v->items = kr_realloc(v->items, v->capacity * sizeof(point));
  }
  v->items[v->count++] = x;
}

static int64_t bench(void) {
  ints is = {0, 0, 0};
  points ps = {0, 0, 0};
  int64_t sum = 0;
  int n = 10000000;
  for (int i = 0; i < n; i++) {
    push_int(&is, i);
    point p = {i, 2 * i};
    push_point(&ps, p);
  }
  for (uint32_t i = 0; i < is.count; i++) { sum += is.items[i]; sum += ps.items[i].y; }
  return sum;
}

BENCH(bench())
