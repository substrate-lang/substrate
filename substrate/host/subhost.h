/* subhost: the substrate host over the wasmtime C API.
 *
 * One sub_host is one store: an engine, a linker, and the shared memory and
 * table that the "rt" instance exports. See docs/spec.md section 4.
 *
 * Rule for embedders (stage0 calls this from Chez): no function here keeps a
 * pointer argument past its own return, and none reads one after it has run
 * wasm code, because wasm may call back into the embedder, whose GC may move
 * the objects those pointers point into.
 */
#ifndef SUBHOST_H
#define SUBHOST_H

#include <stddef.h>
#include <stdint.h>

typedef struct sub_host sub_host;

/* Expander API callback (stage0 only). op is one of SUB_OP_*. The return
 * value is the i32 result. To abort instead, call sub_request_trap before
 * returning. */
typedef int32_t (*sub_callback)(int32_t op, int32_t a0, int32_t a1);

enum {
  SUB_OP_SYNTAX_LOCAL_VALUE = 1,
  SUB_OP_SYNTAX_ERROR = 2,
  SUB_OP_FREE_IDENTIFIER_EQ = 3,
};

sub_host *sub_host_new(void);
void sub_host_free(sub_host *h);

/* All int-returning calls return 0 on success, nonzero on failure; the
 * message is then available from sub_last_error. */
const char *sub_last_error(sub_host *h);

/* Compile and instantiate a module, link its imports by name, and register
 * it under `name`. Instantiating "rt" also makes its memory and table the
 * store's shared memory and table. */
int sub_instantiate(sub_host *h, const char *name, const uint8_t *bytes, size_t len);

/* Call inst.fn with up to 6 i32 arguments. A single i32 result is left in
 * sub_result. */
int sub_call(sub_host *h, const char *inst, const char *fn, int nargs,
             int32_t a0, int32_t a1, int32_t a2, int32_t a3, int32_t a4, int32_t a5);

/* Call the function at index in the shared table. */
int sub_call_index(sub_host *h, int32_t index, int nargs, int32_t a0, int32_t a1, int32_t a2);

int32_t sub_result(sub_host *h);

/* Shared memory access. The base pointer is invalid after any call that
 * runs wasm (memory may grow), so fetch it again each time. */
uintptr_t sub_mem_base(sub_host *h);
size_t sub_mem_size(sub_host *h);
int sub_mem_write(sub_host *h, uint32_t addr, const uint8_t *src, size_t len);

void sub_set_callback(sub_host *h, sub_callback cb);
void sub_request_trap(sub_host *h, const char *msg);

#endif
