/* Lifecycle: benchmark. What the C versions of the benchmarks share:
   K&R's allocator, as the C example's runtime has it (../runtime.sub),
   over memory from sbrk, so that both allocate alike; and the entry. Built
   natively, main prints what run gives; built for wasm, run is exported,
   and wasmtime --invoke prints it. */
#include <stddef.h>
#include <stdint.h>

#ifdef __wasm__
extern unsigned char __heap_base;
static uintptr_t brk_;

static void *sbrk_(size_t n) {
  if (!brk_) brk_ = ((uintptr_t)&__heap_base + 7) & ~(uintptr_t)7;
  uintptr_t p = brk_, end = (brk_ + n + 7) & ~(uintptr_t)7;
  size_t size = __builtin_wasm_memory_size(0) << 16;
  if (end > size && __builtin_wasm_memory_grow(0, (end - size + 65535) >> 16) == (size_t)-1) return 0;
  brk_ = end;
  return (void *)p;
}

#define BENCH(e) __attribute__((export_name("run"))) int64_t run(void) { return (e); }
#else
#include <stdio.h>
#include <sys/mman.h>
static char *brk_;

static void *sbrk_(size_t n) {
  if (!brk_) brk_ = mmap(0, (size_t)8 << 30, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  char *p = brk_;
  brk_ += (n + 7) & ~(size_t)7;
  return p;
}

#define BENCH(e) int main(void) { printf("%lld\n", (long long)(e)); return 0; }
#endif

typedef struct header { struct header *next; uint32_t size; } header;
static header base, *freep;

static void kr_free(void *block);

static header *more_memory(uint32_t units) {
  uint32_t n = units < 1024 ? 1024 : units;
  header *p = sbrk_(n * sizeof(header));
  if (!p) return 0;
  p->size = n;
  kr_free(p + 1);
  return freep;
}

static void *kr_malloc(size_t n) {
  uint32_t units = (n + sizeof(header) - 1) / sizeof(header) + 1;
  header *prev = freep;
  if (!prev) { base.next = freep = prev = &base; base.size = 0; }
  for (header *p = prev->next;; prev = p, p = p->next) {
    if (p->size >= units) {
      if (p->size == units) prev->next = p->next;
      else { p->size -= units; p += p->size; p->size = units; }
      freep = prev;
      return p + 1;
    }
    if (p == freep && !(p = more_memory(units))) return 0;
  }
}

static void kr_free(void *block) {
  header *b = (header *)block - 1, *p = freep;
  for (; !(b > p && b < p->next); p = p->next)
    if (p >= p->next && (b > p || b < p->next)) break;
  if (b + b->size == p->next) { b->size += p->next->size; b->next = p->next->next; }
  else b->next = p->next;
  if (p + p->size == b) { p->size += b->size; p->next = b->next; }
  else p->next = b;
  freep = p;
}

static void *kr_calloc(size_t count, size_t size) {
  void *p = kr_malloc(count * size);
  if (p) __builtin_memset(p, 0, count * size);
  return p;
}
