/* Lifecycle: permanent. After bootstrap the host runs the compiler. */
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

/* ---- memory ----------------------------------------------------------- */

static uint8_t *range(wasmtime_context_t *ctx, const wasmtime_memory_t *mem, uint32_t addr, uint32_t len) {
  size_t size = wasmtime_memory_data_size(ctx, mem);
  if ((uint64_t)addr + len > size) return NULL;
  return wasmtime_memory_data(ctx, mem) + addr;
}

/* The calling instance's memory: the one it exports as "memory". */
static bool caller_memory(wasmtime_caller_t *caller, wasmtime_memory_t *out) {
  wasmtime_extern_t ext;
  if (!wasmtime_caller_export_get(caller, "memory", 6, &ext) || ext.kind != WASMTIME_EXTERN_MEMORY) return false;
  *out = ext.of.memory;
  return true;
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

/* A module part's instance name is "<module>@<phase>+<shift>" (spec 3.2).
 * Compiled parts import from other parts by names relative to their own
 * module at shift 0; instantiating at shift s adds s to each such name.
 * Writes the mapped name to out; other names are copied unchanged. */
static void shift_name(const char *name, size_t len, int32_t shift, char *out, size_t cap) {
  size_t plus = len;
  for (size_t i = len; i > 0; i--)
    if (name[i - 1] == '+') { plus = i - 1; break; }
  bool part = plus < len && memchr(name, '@', plus) != NULL && plus + 1 < len;
  for (size_t i = plus + 1; part && i < len; i++)
    if (name[i] < '0' || name[i] > '9') part = false;
  if (!part || shift == 0) {
    snprintf(out, cap, "%.*s", (int)len, name);
    return;
  }
  /* Parse the digits within len: an import name is not NUL-terminated. */
  long t = 0;
  for (size_t i = plus + 1; i < len; i++) t = t * 10 + (name[i] - '0');
  snprintf(out, cap, "%.*s+%ld", (int)plus, name, t + shift);
}

int sub_instantiate_shifted(sub_host *h, const char *name, const uint8_t *bytes, size_t len, int32_t shift) {
  char *name_copy = strdup(name);
  uint8_t *copy = malloc(len ? len : 1);
  memcpy(copy, bytes, len);
  int rc = 1;
  wasmtime_module_t *module = NULL;
  wasm_importtype_vec_t imports = {0};
  wasmtime_extern_t *externs = NULL;
  wasmtime_error_t *error = wasmtime_module_new(h->engine, copy, len, &module);
  if (error) {
    take_failure(h, "compile", error, NULL);
    goto done;
  }
  wasmtime_module_imports(module, &imports);
  externs = calloc(imports.size ? imports.size : 1, sizeof *externs);
  for (size_t i = 0; i < imports.size; i++) {
    const wasm_name_t *mod = wasm_importtype_module(imports.data[i]);
    const wasm_name_t *field = wasm_importtype_name(imports.data[i]);
    char mapped[512];
    shift_name(mod->data, mod->size, shift, mapped, sizeof mapped);
    if (!wasmtime_linker_get(h->linker, h->ctx, mapped, strlen(mapped), field->data, field->size, &externs[i])) {
      set_err(h, "instantiate %s: no import %s.%.*s", name_copy, mapped, (int)field->size, field->data);
      goto done;
    }
  }
  wasmtime_instance_t inst;
  wasm_trap_t *trap = NULL;
  error = wasmtime_instance_new(h->ctx, module, externs, imports.size, &inst, &trap);
  if (error || trap) {
    take_failure(h, "instantiate", error, trap);
    goto done;
  }
  error = wasmtime_linker_define_instance(h->linker, h->ctx, name_copy, strlen(name_copy), &inst);
  if (error) {
    take_failure(h, "register", error, NULL);
    goto done;
  }
  rc = 0;
done:
  free(externs);
  wasm_importtype_vec_delete(&imports);
  if (module) wasmtime_module_delete(module);
  free(copy);
  free(name_copy);
  return rc;
}

/* ---- calls ------------------------------------------------------------ */

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
  wasm_functype_t *ty = wasmtime_func_type(h->ctx, &func);
  size_t nparams = wasm_functype_params(ty)->size;
  size_t nresults = wasm_functype_results(ty)->size;
  wasm_functype_delete(ty);
  if ((size_t)nargs != nparams || nresults > 1) {
    set_err(h, "call: %s.%s takes %zu arguments and returns %zu values, given %d arguments",
            inst, fn, nparams, nresults, nargs);
    return 1;
  }
  wasmtime_val_t argv[6], res[1];
  for (int i = 0; i < nargs; i++) {
    argv[i].kind = WASMTIME_I32;
    argv[i].of.i32 = args[i];
  }
  wasm_trap_t *trap = NULL;
  wasmtime_error_t *error = wasmtime_func_call(h->ctx, &func, argv, (size_t)nargs, res, nresults, &trap);
  if (error || trap) {
    take_failure(h, "trap", error, trap);
    return 1;
  }
  h->result = (nresults == 1 && res[0].kind == WASMTIME_I32) ? res[0].of.i32 : 0;
  return 0;
}

/* ---- host imports ----------------------------------------------------- */
/* Every pointer a host import receives is into the caller's own memory,
 * the one it exports as "memory" (spec section 4). */

/* Run a host function body with h->ctx set to the caller's context. */
#define ENTER(h, caller) wasmtime_context_t *saved_ctx = (h)->ctx; (h)->ctx = wasmtime_caller_context(caller)
#define LEAVE(h) (h)->ctx = saved_ctx

static wasm_trap_t *trap_msg(const char *msg) { return wasmtime_trap_new(msg, strlen(msg)); }

static wasm_trap_t *host_write(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                               size_t nargs, wasmtime_val_t *results, size_t nresults) {
  int32_t fd = args[0].of.i32;
  uint32_t ptr = (uint32_t)args[1].of.i32, len = (uint32_t)args[2].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.write: caller exports no memory");
  uint8_t *p = range(wasmtime_caller_context(caller), &mem, ptr, len);
  if (!p) return trap_msg("host.write: out of bounds");
  FILE *out = fd == 2 ? stderr : stdout;
  fwrite(p, 1, len, out);
  fflush(out);
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = (int32_t)len;
  return NULL;
}

static wasm_trap_t *host_trap(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                              size_t nargs, wasmtime_val_t *results, size_t nresults) {
  uint32_t ptr = (uint32_t)args[0].of.i32, len = (uint32_t)args[1].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.trap: caller exports no memory");
  uint8_t *p = range(wasmtime_caller_context(caller), &mem, ptr, len);
  return p ? wasmtime_trap_new((const char *)p, len) : trap_msg("host.trap: out of bounds");
}

static wasm_trap_t *host_instantiate(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                     size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  uint32_t np = (uint32_t)args[0].of.i32, nl = (uint32_t)args[1].of.i32;
  uint32_t bp = (uint32_t)args[2].of.i32, bl = (uint32_t)args[3].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.instantiate: caller exports no memory");
  wasmtime_context_t *cctx = wasmtime_caller_context(caller);
  uint8_t *name = range(cctx, &mem, np, nl), *bytes = range(cctx, &mem, bp, bl);
  if (!name || !bytes) return trap_msg("host.instantiate: out of bounds");
  /* Copy out before instantiating: the new module's start function may
   * grow the caller's memory and move it. */
  char *name_copy = malloc(nl + 1);
  memcpy(name_copy, name, nl);
  name_copy[nl] = '\0';
  uint8_t *copy = malloc(bl ? bl : 1);
  memcpy(copy, bytes, bl);
  ENTER(h, caller);
  int rc = instantiate(h, name_copy, nl, copy, bl);
  LEAVE(h);
  free(copy);
  free(name_copy);
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = rc;
  return NULL;
}

/* Append inst.field to the caller's table (exported as "table"). */
static wasm_trap_t *host_export_index(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                      size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  uint32_t ip = (uint32_t)args[0].of.i32, il = (uint32_t)args[1].of.i32;
  uint32_t fp = (uint32_t)args[2].of.i32, fl = (uint32_t)args[3].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.export_index: caller exports no memory");
  wasmtime_extern_t table;
  if (!wasmtime_caller_export_get(caller, "table", 5, &table) || table.kind != WASMTIME_EXTERN_TABLE)
    return trap_msg("host.export_index: caller exports no table");
  wasmtime_context_t *cctx = wasmtime_caller_context(caller);
  uint8_t *inst = range(cctx, &mem, ip, il), *field = range(cctx, &mem, fp, fl);
  if (!inst || !field) return trap_msg("host.export_index: out of bounds");
  int32_t index = -1;
  wasmtime_extern_t ext;
  if (wasmtime_linker_get(h->linker, cctx, (const char *)inst, il, (const char *)field, fl, &ext) &&
      ext.kind == WASMTIME_EXTERN_FUNC) {
    wasmtime_val_t init = {.kind = WASMTIME_FUNCREF};
    init.of.funcref = ext.of.func;
    uint64_t prev = 0;
    wasmtime_error_t *error = wasmtime_table_grow(cctx, &table.of.table, 1, &init, &prev);
    if (error)
      take_failure(h, "host.export_index", error, NULL);
    else
      index = (int32_t)prev;
  }
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = index;
  return NULL;
}

static wasm_trap_t *host_error_message(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                       size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  uint32_t bp = (uint32_t)args[0].of.i32, cap = (uint32_t)args[1].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.error_message: caller exports no memory");
  size_t n = strlen(h->err);
  if (n > cap) n = cap;
  uint8_t *buf = range(wasmtime_caller_context(caller), &mem, bp, (uint32_t)n);
  if (buf) memcpy(buf, h->err, n);
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = buf ? (int32_t)n : -1;
  return NULL;
}

/* Expander queries (stage0 only): forward to the embedder's callback. env
 * points at an op code; the host is found through the store's data. */
static const int32_t op_codes[] = {SUB_OP_SYNTAX_LOCAL_VALUE, SUB_OP_SYNTAX_ERROR, SUB_OP_FREE_IDENTIFIER_EQ,
                                   SUB_OP_BINDING_KIND, SUB_OP_LOCAL_EXPAND};

static wasm_trap_t *expander_call(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                  size_t nargs, wasmtime_val_t *results, size_t nresults) {
  int32_t op = *(const int32_t *)env;
  sub_host *h = wasmtime_context_get_data(wasmtime_caller_context(caller));
  if (!h->cb) return trap_msg("expander query used outside the expander");
  ENTER(h, caller);
  int32_t r = h->cb(op, nargs > 0 ? args[0].of.i32 : 0, nargs > 1 ? args[1].of.i32 : 0);
  LEAVE(h);
  if (h->pending_trap) {
    wasm_trap_t *t = trap_msg(h->pending_trap);
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
  wasmtime_config_wasm_function_references_set(config, true);
  wasmtime_config_wasm_gc_set(config, true);
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
      define(h, "expander", "free-identifier=?", 2, 1, expander_call, (void *)&op_codes[2]) ||
      define(h, "expander", "binding-kind", 1, 1, expander_call, (void *)&op_codes[3]) ||
      define(h, "expander", "local-expand", 1, 1, expander_call, (void *)&op_codes[4])) {
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
