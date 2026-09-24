/* Lifecycle: permanent. After bootstrap the host runs the compiler. */
/* subhost: the substrate host over the wasmtime C API.
 *
 * One sub_host is one store and a linker. Instances are registered by name
 * and link to each other by name. All hosts share one engine, so a wasm
 * module is compiled once per process however many stores instantiate it.
 * The host owns no memory: each of its imports reads pointers from the
 * calling instance's own memory (docs/spec.md section 4).
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

/* Expander query callback (stage0 only). op is one of SUB_OP_*. The return
 * value is the i32 result. To abort instead, call sub_request_trap before
 * returning. */
typedef int32_t (*sub_callback)(int32_t op, int32_t a0, int32_t a1);

enum {
  SUB_OP_SYNTAX_LOCAL_VALUE = 1,
  SUB_OP_SYNTAX_ERROR = 2,
  SUB_OP_FREE_IDENTIFIER_EQ = 3,
  SUB_OP_BINDING_KIND = 4,
  SUB_OP_LOCAL_EXPAND = 5,
  SUB_OP_LIFT_DEFINITION = 6,
};

sub_host *sub_host_new(void);
void sub_host_free(sub_host *h);

/* All int-returning calls return 0 on success, nonzero on failure; the
 * message is then available from sub_last_error. */
const char *sub_last_error(sub_host *h);

/* Compile and instantiate a module, link its imports by name, and register
 * it under `name`. */
int sub_instantiate(sub_host *h, const char *name, const uint8_t *bytes, size_t len);

/* Like sub_instantiate, for a module part compiled at shift 0 and
 * instantiated at `shift`: imports from "<module>@<phase>+<t>" resolve to
 * "<module>@<phase>+<t + shift>" (spec 3.2). */
int sub_instantiate_shifted(sub_host *h, const char *name, const uint8_t *bytes, size_t len, int32_t shift);

/* Call inst.fn with up to 6 i32 arguments. A single i32 result is left in
 * sub_result. */
int sub_call(sub_host *h, const char *inst, const char *fn, int nargs,
             int32_t a0, int32_t a1, int32_t a2, int32_t a3, int32_t a4, int32_t a5);
int32_t sub_result(sub_host *h);

void sub_set_callback(sub_host *h, sub_callback cb);
void sub_request_trap(sub_host *h, const char *msg);

/* Profiling, when SUBHOST_PROFILE is set: time is kept per category and
 * printed at exit; SUBHOST_PROFILE=2 also logs each wasm compile. The
 * embedder marks its own work with categories from
 * SUB_PROFILE_FIRST_EMBEDDER on: marshal, codegen, read. */
enum { SUB_PROFILE_FIRST_EMBEDDER = 4 };
void sub_profile_push(int category);
void sub_profile_pop(void);

#endif
