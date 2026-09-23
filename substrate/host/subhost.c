/* subhost: see subhost.h and docs/spec.md section 4. */
#include "subhost.h"

#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wasm.h>
#include <wasmtime.h>

struct sub_host {
  wasm_engine_t *engine;
  wasmtime_store_t *store;
  wasmtime_linker_t *linker;
  /* The context every call uses. Inside a host function it is the caller's
   * context, so nested calls into wasm go through the right one. */
  wasmtime_context_t *ctx;
  wasmtime_memory_t mem;
  wasmtime_table_t tbl;
  bool have_rt;
  int32_t result;
  sub_callback cb;
  char *pending_trap;
  char err[8192];
};

static void set_err(sub_host *h, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(h->err, sizeof h->err, fmt, ap);
  va_end(ap);
}

/* Record a wasmtime error or trap as the last error; consumes it. */
static void take_failure(sub_host *h, const char *what, wasmtime_error_t *error, wasm_trap_t *trap) {
  wasm_byte_vec_t msg = {0};
  if (error) {
    wasmtime_error_message(error, &msg);
    wasmtime_error_delete(error);
  } else if (trap) {
    wasm_trap_message(trap, &msg);
    wasm_trap_delete(trap);
  }
  int n = (int)msg.size;
  while (n > 0 && msg.data[n - 1] == '\0') n--;
  char *text = strndup(msg.data ? msg.data : "", (size_t)n);
  wasm_byte_vec_delete(&msg);
  /* wasmtime puts the backtrace first and the cause last:
   *   error while executing at wasm backtrace:\n ...\n\nCaused by:\n    cause
   * Put the cause first so the first line of a report says what happened. */
  const char *marker = "\n\nCaused by:\n";
  char *caused = strstr(text, marker);
  if (caused) {
    *caused = '\0';
    const char *cause = caused + strlen(marker);
    while (*cause == ' ') cause++;
    const char *context = text;
    const char *prefix = "error while executing at ";
    if (strncmp(context, prefix, strlen(prefix)) == 0) context += strlen(prefix);
    set_err(h, "%s: %s\n%s", what, cause, context);
  } else {
    set_err(h, "%s: %s", what, text);
  }
  free(text);
}

const char *sub_last_error(sub_host *h) { return h->err; }
int32_t sub_result(sub_host *h) { return h->result; }

/* ---- shared memory ---------------------------------------------------- */

static uint8_t *mem_ptr(sub_host *h, uint32_t addr, uint32_t len) {
  if (!h->have_rt) return NULL;
  size_t size = wasmtime_memory_data_size(h->ctx, &h->mem);
  if ((uint64_t)addr + len > size) return NULL;
  return wasmtime_memory_data(h->ctx, &h->mem) + addr;
}

uintptr_t sub_mem_base(sub_host *h) {
  return h->have_rt ? (uintptr_t)wasmtime_memory_data(h->ctx, &h->mem) : 0;
}

size_t sub_mem_size(sub_host *h) {
  return h->have_rt ? wasmtime_memory_data_size(h->ctx, &h->mem) : 0;
}

int sub_mem_write(sub_host *h, uint32_t addr, const uint8_t *src, size_t len) {
  uint8_t *dst = mem_ptr(h, addr, (uint32_t)len);
  if (!dst) {
    set_err(h, "mem_write: [%u, +%zu) out of bounds", addr, len);
    return 1;
  }
  memcpy(dst, src, len);
  return 0;
}

/* ---- instantiation ---------------------------------------------------- */

static int instantiate(sub_host *h, const char *name, size_t name_len, const uint8_t *bytes, size_t len) {
  wasmtime_module_t *module = NULL;
  wasmtime_error_t *error = wasmtime_module_new(h->engine, bytes, len, &module);
  if (error) {
    take_failure(h, "compile", error, NULL);
    return 1;
  }
  wasmtime_instance_t inst;
  wasm_trap_t *trap = NULL;
  error = wasmtime_linker_instantiate(h->linker, h->ctx, module, &inst, &trap);
  wasmtime_module_delete(module);
  if (error || trap) {
    take_failure(h, "instantiate", error, trap);
    return 1;
  }
  error = wasmtime_linker_define_instance(h->linker, h->ctx, name, name_len, &inst);
  if (error) {
    take_failure(h, "register", error, NULL);
    return 1;
  }
  if (name_len == 2 && memcmp(name, "rt", 2) == 0) {
    wasmtime_extern_t ext;
    if (!wasmtime_instance_export_get(h->ctx, &inst, "mem", 3, &ext) || ext.kind != WASMTIME_EXTERN_MEMORY) {
      set_err(h, "rt does not export memory 'mem'");
      return 1;
    }
    h->mem = ext.of.memory;
    if (!wasmtime_instance_export_get(h->ctx, &inst, "tbl", 3, &ext) || ext.kind != WASMTIME_EXTERN_TABLE) {
      set_err(h, "rt does not export table 'tbl'");
      return 1;
    }
    h->tbl = ext.of.table;
    h->have_rt = true;
  }
  return 0;
}

int sub_instantiate(sub_host *h, const char *name, const uint8_t *bytes, size_t len) {
  /* Copy both arguments first: instantiation runs start functions. */
  char *name_copy = strdup(name);
  uint8_t *copy = malloc(len ? len : 1);
  memcpy(copy, bytes, len);
  int rc = instantiate(h, name_copy, strlen(name_copy), copy, len);
  free(copy);
  free(name_copy);
  return rc;
}

/* ---- calls ------------------------------------------------------------ */

static int call_func(sub_host *h, const wasmtime_func_t *fn, int nargs, const int32_t *args) {
  wasm_functype_t *ty = wasmtime_func_type(h->ctx, fn);
  size_t nparams = wasm_functype_params(ty)->size;
  size_t nresults = wasm_functype_results(ty)->size;
  wasm_functype_delete(ty);
  if ((size_t)nargs != nparams || nresults > 1) {
    set_err(h, "call: function takes %zu arguments and returns %zu values, given %d arguments",
            nparams, nresults, nargs);
    return 1;
  }
  wasmtime_val_t argv[6], res[1];
  for (int i = 0; i < nargs; i++) {
    argv[i].kind = WASMTIME_I32;
    argv[i].of.i32 = args[i];
  }
  wasm_trap_t *trap = NULL;
  wasmtime_error_t *error = wasmtime_func_call(h->ctx, fn, argv, (size_t)nargs, res, nresults, &trap);
  if (error || trap) {
    take_failure(h, "trap", error, trap);
    return 1;
  }
  h->result = (nresults == 1 && res[0].kind == WASMTIME_I32) ? res[0].of.i32 : 0;
  return 0;
}

int sub_call(sub_host *h, const char *inst, const char *fn, int nargs,
             int32_t a0, int32_t a1, int32_t a2, int32_t a3, int32_t a4, int32_t a5) {
  int32_t args[6] = {a0, a1, a2, a3, a4, a5};
  if (nargs < 0 || nargs > 6) {
    set_err(h, "call: bad argument count %d", nargs);
    return 1;
  }
  wasmtime_extern_t ext;
  if (!wasmtime_linker_get(h->linker, h->ctx, inst, strlen(inst), fn, strlen(fn), &ext) ||
      ext.kind != WASMTIME_EXTERN_FUNC) {
    set_err(h, "call: no function %s.%s", inst, fn);
    return 1;
  }
  wasmtime_func_t func = ext.of.func;
  return call_func(h, &func, nargs, args);
}

int sub_call_index(sub_host *h, int32_t index, int nargs, int32_t a0, int32_t a1, int32_t a2) {
  int32_t args[3] = {a0, a1, a2};
  if (!h->have_rt) {
    set_err(h, "call_index: rt is not instantiated");
    return 1;
  }
  wasmtime_val_t val;
  if (index < 0 || !wasmtime_table_get(h->ctx, &h->tbl, (uint64_t)index, &val) ||
      val.kind != WASMTIME_FUNCREF || val.of.funcref.store_id == 0) {
    set_err(h, "call_index: no function at table index %d", index);
    return 1;
  }
  return call_func(h, &val.of.funcref, nargs, args);
}

/* ---- host imports ----------------------------------------------------- */

/* Run a host function body with h->ctx set to the caller's context. */
#define ENTER(h, caller) wasmtime_context_t *saved_ctx = (h)->ctx; (h)->ctx = wasmtime_caller_context(caller)
#define LEAVE(h) (h)->ctx = saved_ctx

static wasm_trap_t *trap_msg(const char *msg, size_t len) { return wasmtime_trap_new(msg, len); }

static wasm_trap_t *host_write(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                               size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  ENTER(h, caller);
  int32_t fd = args[0].of.i32;
  uint32_t ptr = (uint32_t)args[1].of.i32, len = (uint32_t)args[2].of.i32;
  uint8_t *p = mem_ptr(h, ptr, len);
  LEAVE(h);
  if (!p) return trap_msg("host.write: out of bounds", 25);
  FILE *out = fd == 2 ? stderr : stdout;
  fwrite(p, 1, len, out);
  fflush(out);
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = (int32_t)len;
  return NULL;
}

static wasm_trap_t *host_trap(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                              size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  ENTER(h, caller);
  uint32_t ptr = (uint32_t)args[0].of.i32, len = (uint32_t)args[1].of.i32;
  uint8_t *p = mem_ptr(h, ptr, len);
  wasm_trap_t *t = p ? trap_msg((const char *)p, len) : trap_msg("host.trap: out of bounds", 24);
  LEAVE(h);
  return t;
}

static wasm_trap_t *host_instantiate(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                     size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  ENTER(h, caller);
  uint32_t np = (uint32_t)args[0].of.i32, nl = (uint32_t)args[1].of.i32;
  uint32_t bp = (uint32_t)args[2].of.i32, bl = (uint32_t)args[3].of.i32;
  uint8_t *name = mem_ptr(h, np, nl), *bytes = mem_ptr(h, bp, bl);
  int rc = 1;
  if (!name || !bytes) {
    set_err(h, "host.instantiate: out of bounds");
  } else {
    char *name_copy = malloc(nl + 1);
    memcpy(name_copy, name, nl);
    name_copy[nl] = '\0';
    uint8_t *copy = malloc(bl ? bl : 1);
    memcpy(copy, bytes, bl);
    rc = instantiate(h, name_copy, nl, copy, bl);
    free(copy);
    free(name_copy);
  }
  LEAVE(h);
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = rc;
  return NULL;
}

static wasm_trap_t *host_export_index(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                      size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  ENTER(h, caller);
  uint32_t ip = (uint32_t)args[0].of.i32, il = (uint32_t)args[1].of.i32;
  uint32_t fp = (uint32_t)args[2].of.i32, fl = (uint32_t)args[3].of.i32;
  uint8_t *inst = mem_ptr(h, ip, il), *field = mem_ptr(h, fp, fl);
  int32_t index = -1;
  wasmtime_extern_t ext;
  if (inst && field && h->have_rt &&
      wasmtime_linker_get(h->linker, h->ctx, (const char *)inst, il, (const char *)field, fl, &ext) &&
      ext.kind == WASMTIME_EXTERN_FUNC) {
    wasmtime_val_t init = {.kind = WASMTIME_FUNCREF};
    init.of.funcref = ext.of.func;
    uint64_t prev = 0;
    wasmtime_error_t *error = wasmtime_table_grow(h->ctx, &h->tbl, 1, &init, &prev);
    if (error)
      take_failure(h, "host.export_index", error, NULL);
    else
      index = (int32_t)prev;
  }
  LEAVE(h);
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = index;
  return NULL;
}

static wasm_trap_t *host_error_message(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                       size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  ENTER(h, caller);
  uint32_t bp = (uint32_t)args[0].of.i32, cap = (uint32_t)args[1].of.i32;
  size_t n = strlen(h->err);
  if (n > cap) n = cap;
  uint8_t *buf = mem_ptr(h, bp, (uint32_t)n);
  if (buf) memcpy(buf, h->err, n);
  LEAVE(h);
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = buf ? (int32_t)n : -1;
  return NULL;
}

/* Expander API: forward to the embedder's callback. env points at an op
 * code; the host is found through the store's data pointer. */
static const int32_t op_codes[] = {SUB_OP_SYNTAX_LOCAL_VALUE, SUB_OP_SYNTAX_ERROR, SUB_OP_FREE_IDENTIFIER_EQ};

static wasm_trap_t *expander_call(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                  size_t nargs, wasmtime_val_t *results, size_t nresults) {
  int32_t op = *(const int32_t *)env;
  wasmtime_context_t *cctx = wasmtime_caller_context(caller);
  sub_host *h = wasmtime_context_get_data(cctx);
  if (!h->cb) return trap_msg("expander API used outside the expander", 38);
  ENTER(h, caller);
  int32_t r = h->cb(op, nargs > 0 ? args[0].of.i32 : 0, nargs > 1 ? args[1].of.i32 : 0);
  LEAVE(h);
  if (h->pending_trap) {
    wasm_trap_t *t = trap_msg(h->pending_trap, strlen(h->pending_trap));
    free(h->pending_trap);
    h->pending_trap = NULL;
    return t;
  }
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = r;
  return NULL;
}

void sub_set_callback(sub_host *h, sub_callback cb) { h->cb = cb; }

void sub_request_trap(sub_host *h, const char *msg) {
  free(h->pending_trap);
  h->pending_trap = strdup(msg);
}

/* ---- setup ------------------------------------------------------------ */

static wasm_functype_t *i32_functype(int nparams, int nresults) {
  wasm_valtype_t *ps[8], *rs[1];
  for (int i = 0; i < nparams; i++) ps[i] = wasm_valtype_new(WASM_I32);
  for (int i = 0; i < nresults; i++) rs[i] = wasm_valtype_new(WASM_I32);
  wasm_valtype_vec_t params, results;
  wasm_valtype_vec_new(&params, (size_t)nparams, ps);
  wasm_valtype_vec_new(&results, (size_t)nresults, rs);
  return wasm_functype_new(&params, &results);
}

static int define(sub_host *h, const char *module, const char *name, int np, int nr,
                  wasmtime_func_callback_t cb, void *env) {
  wasm_functype_t *ty = i32_functype(np, nr);
  wasmtime_error_t *error =
      wasmtime_linker_define_func(h->linker, module, strlen(module), name, strlen(name), ty, cb, env, NULL);
  wasm_functype_delete(ty);
  if (error) {
    take_failure(h, "define", error, NULL);
    return 1;
  }
  return 0;
}

sub_host *sub_host_new(void) {
  sub_host *h = calloc(1, sizeof *h);
  wasm_config_t *config = wasm_config_new();
  wasmtime_config_wasm_tail_call_set(config, true);
  wasmtime_config_wasm_multi_value_set(config, true);
  wasmtime_config_wasm_bulk_memory_set(config, true);
  wasmtime_config_wasm_reference_types_set(config, true);
  /* max_wasm_stack may not exceed async_stack_size, even without async. */
  wasmtime_config_async_stack_size_set(config, (size_t)8 << 20);
  wasmtime_config_max_wasm_stack_set(config, (size_t)4 << 20);
  h->engine = wasm_engine_new_with_config(config);
  h->store = wasmtime_store_new(h->engine, h, NULL);
  h->ctx = wasmtime_store_context(h->store);
  h->linker = wasmtime_linker_new(h->engine);
  if (define(h, "host", "write", 3, 1, host_write, h) ||
      define(h, "host", "trap", 2, 0, host_trap, h) ||
      define(h, "host", "instantiate", 4, 1, host_instantiate, h) ||
      define(h, "host", "export_index", 4, 1, host_export_index, h) ||
      define(h, "host", "error_message", 2, 1, host_error_message, h) ||
      define(h, "expander", "syntax-local-value", 1, 1, expander_call, (void *)&op_codes[0]) ||
      define(h, "expander", "syntax-error", 2, 1, expander_call, (void *)&op_codes[1]) ||
      define(h, "expander", "free-identifier=?", 2, 1, expander_call, (void *)&op_codes[2])) {
    fprintf(stderr, "subhost: %s\n", h->err);
    abort();
  }
  return h;
}

void sub_host_free(sub_host *h) {
  if (!h) return;
  wasmtime_linker_delete(h->linker);
  wasmtime_store_delete(h->store);
  wasm_engine_delete(h->engine);
  free(h->pending_trap);
  free(h);
}
