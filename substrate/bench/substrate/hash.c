// An open-addressing hash table of 64-bit keys that doubles as it fills.
#include "bench.h"

typedef struct { uint64_t key, value; } entry;

typedef struct { entry *slots; uint64_t size, count; } table;

static entry *slot_of(table *t, uint64_t key) {
  uint64_t mask = t->size - 1;
  entry *slots = t->slots;
  uint64_t i = ((key * 11400714819323198485ull) >> 32) & mask;
  while (slots[i].key != 0 && slots[i].key != key) i = (i + 1) & mask;
  return slots + i;
}

static void grow(table *t) {
  entry *old = t->slots;
  uint64_t n = t->size;
  t->size = n * 2;
  t->slots = kr_calloc((uint32_t)(n * 2), sizeof(entry));
  for (uint64_t i = 0; i < n; i++) {
    entry *e = old + i;
    if (e->key != 0) { entry *s = slot_of(t, e->key); s->key = e->key; s->value = e->value; }
  }
  kr_free(old);
}

static void put(table *t, uint64_t key, uint64_t value) {
  if (2 * (t->count + 1) >= t->size) grow(t);
  entry *e = slot_of(t, key);
  if (e->key == 0) { e->key = key; t->count++; }
  e->value = value;
}

static uint64_t get(table *t, uint64_t key) { return slot_of(t, key)->value; }

static uint64_t next(uint64_t x) { return x * 6364136223846793005ull + 1442695040888963407ull; }

static int64_t bench(void) {
  table t;
  uint64_t x = 1, sum = 0;
  int n = 4000000;
  t.size = 16;
  t.count = 0;
  t.slots = kr_calloc(16, sizeof(entry));
  for (int i = 0; i < n; i++) { x = next(x); put(&t, x | 1, i); }
  x = 1;
  for (int i = 0; i < 2 * n; i++) { x = next(x); sum += get(&t, x | 1); }
  return (int64_t)(sum + t.count);
}

BENCH(bench())
