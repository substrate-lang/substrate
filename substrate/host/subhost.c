/* Lifecycle: permanent. After bootstrap the host runs the compiler. */
/* subhost: see subhost.h and docs/spec.md section 4. */
#include "subhost.h"

#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wasm.h>
#include <wasmtime.h>

struct sub_host {
  wasmtime_store_t *store;
  wasmtime_linker_t *linker;
  /* The context every call uses. Inside a host function it is the caller's
   * context, so nested calls into wasm go through the right one. */
  wasmtime_context_t *ctx;
  int32_t result;
  sub_callback cb;
  char *pending_trap;
  char **args; /* the program's command-line arguments */
  int nargs;
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

/* ---- profile ---------------------------------------------------------- */

/* With SUBHOST_PROFILE set in the environment, the host keeps the time
 * spent in each category, excluding the categories nested in it, and
 * prints the totals to stderr at exit. The embedder marks its own
 * categories with sub_profile_push and sub_profile_pop. */
enum { P_EMBEDDER, P_WASM, P_COMPILE, P_INSTANTIATE, P_COUNT = SUB_PROFILE_FIRST_EMBEDDER + 8 };

static int profiling = -1;
static double p_time[P_COUNT];
static long p_entries[P_COUNT];
static int p_stack[1024];
static int p_depth;
static double p_since;
static long p_calls, p_callbacks[8], p_compiles, p_cache_hits;
static size_t p_compiled_bytes;
static const char *p_naming = "";  /* the instance being compiled, for the log */

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec * 1e-9;
}

static const char *p_name(int c) {
  static const char *names[] = {"embedder", "wasm", "cranelift", "instantiate"};
  static const char *embedder[] = {"marshal", "codegen", "read"};
  if (c < SUB_PROFILE_FIRST_EMBEDDER) return names[c];
  if (c - SUB_PROFILE_FIRST_EMBEDDER < 3) return embedder[c - SUB_PROFILE_FIRST_EMBEDDER];
  return "?";
}

static void p_report(void) {
  double total = 0;
  for (int c = 0; c < P_COUNT; c++) total += p_time[c];
  fprintf(stderr, "subhost profile (seconds, exclusive):\n");
  for (int c = 0; c < P_COUNT; c++)
    if (p_entries[c] || p_time[c] > 0)
      fprintf(stderr, "  %-12s %8.3f  %5.1f%%  %ld entries\n", p_name(c), p_time[c],
              total > 0 ? 100 * p_time[c] / total : 0, p_entries[c]);
  fprintf(stderr, "  %-12s %8.3f\n", "total", total);
  fprintf(stderr, "  calls into wasm %ld; compiles %ld (%zu bytes), cache hits %ld\n", p_calls, p_compiles,
          p_compiled_bytes, p_cache_hits);
  fprintf(stderr, "  queries: syntax-local-value %ld, raise-syntax-error %ld, free-identifier=? %ld, identifier-binding-kind %ld, local-expand %ld, syntax-local-lift-definition %ld\n",
          p_callbacks[1], p_callbacks[2], p_callbacks[3], p_callbacks[4], p_callbacks[5], p_callbacks[6]);
}

static bool p_on(void) {
  if (profiling < 0) {
    profiling = getenv("SUBHOST_PROFILE") != NULL;
    if (profiling) {
      p_since = now();
      atexit(p_report);
    }
  }
  return profiling;
}

static void p_switch(void) {
  double t = now();
  p_time[p_stack[p_depth]] += t - p_since;
  p_since = t;
}

void sub_profile_push(int category) {
  if (!p_on() || p_depth + 1 >= (int)(sizeof p_stack / sizeof p_stack[0])) return;
  p_switch();
  p_stack[++p_depth] = category;
  p_entries[category]++;
}

void sub_profile_pop(void) {
  if (!p_on() || p_depth == 0) return;
  p_switch();
  p_depth--;
}

/* A call into wasm from an embedder category counts as that category: the
 * embedder's marshalling is mostly calls into the syntax library. */
static void p_enter_wasm(void) {
  if (!p_on()) return;
  p_calls++;
  sub_profile_push(p_stack[p_depth] == P_EMBEDDER ? P_WASM : p_stack[p_depth]);
}

/* ---- memory ----------------------------------------------------------- */

static uint8_t *range(wasmtime_context_t *ctx, const wasmtime_memory_t *mem, uint32_t addr, uint32_t len) {
  size_t size = wasmtime_memory_data_size(ctx, mem);
  if ((uint64_t)addr + len > size) return NULL;
  return wasmtime_memory_data(ctx, mem) + addr;
}

/* The len bytes at addr in the memory instance inst exports as "memory". */
static uint8_t *instance_range(sub_host *h, const char *inst, uint32_t addr, size_t len) {
  wasmtime_extern_t ext;
  if (!wasmtime_linker_get(h->linker, h->ctx, inst, strlen(inst), "memory", 6, &ext) ||
      ext.kind != WASMTIME_EXTERN_MEMORY) {
    set_err(h, "memory: %s exports no memory", inst);
    return NULL;
  }
  uint8_t *p = len > UINT32_MAX ? NULL : range(h->ctx, &ext.of.memory, addr, (uint32_t)len);
  if (!p) set_err(h, "memory: %zu bytes at %u are outside %s's memory", len, addr, inst);
  return p;
}

int sub_memory_write(sub_host *h, const char *inst, uint32_t addr, const uint8_t *bytes, size_t len) {
  uint8_t *p = instance_range(h, inst, addr, len);
  if (!p) return 1;
  memcpy(p, bytes, len);
  return 0;
}

int sub_memory_read(sub_host *h, const char *inst, uint32_t addr, uint8_t *out, size_t len) {
  uint8_t *p = instance_range(h, inst, addr, len);
  if (!p) return 1;
  memcpy(out, p, len);
  return 0;
}

/* The calling instance's memory: the one it exports as "memory". */
static bool caller_memory(wasmtime_caller_t *caller, wasmtime_memory_t *out) {
  wasmtime_extern_t ext;
  if (!wasmtime_caller_export_get(caller, "memory", 6, &ext) || ext.kind != WASMTIME_EXTERN_MEMORY) return false;
  *out = ext.of.memory;
  return true;
}


/* ---- compiled modules ------------------------------------------------- */

/* The engine all hosts share. A compiled module belongs to an engine, and
 * stage0 makes a store per module it compiles (docs/spec.md section 3.2),
 * so sharing the engine lets those stores share compiled modules. */
static wasm_engine_t *shared_engine;

static wasm_engine_t *engine(void) {
  if (!shared_engine) {
    wasm_config_t *config = wasm_config_new();
    wasmtime_config_wasm_tail_call_set(config, true);
    wasmtime_config_wasm_multi_value_set(config, true);
    wasmtime_config_wasm_bulk_memory_set(config, true);
    wasmtime_config_wasm_reference_types_set(config, true);
    wasmtime_config_wasm_function_references_set(config, true);
    wasmtime_config_wasm_gc_set(config, true);
    /* With SUBHOST_PERFMAP set, wasmtime writes /tmp/perf-PID.map, which
     * names compiled wasm functions in perf's samples. */
    if (getenv("SUBHOST_PERFMAP"))
      wasmtime_config_profiler_set(config, WASMTIME_PROFILING_STRATEGY_PERFMAP);
    /* max_wasm_stack may not exceed async_stack_size, even without async. */
    wasmtime_config_async_stack_size_set(config, (size_t)8 << 20);
    wasmtime_config_max_wasm_stack_set(config, (size_t)4 << 20);
    shared_engine = wasm_engine_new_with_config(config);
  }
  return shared_engine;
}

/* Every module compiled so far, by its bytes, for the life of the process. */
typedef struct compiled {
  uint64_t hash;
  size_t len;
  uint8_t *bytes;
  wasmtime_module_t *module;
  struct compiled *next;
} compiled;

enum { COMPILED_BUCKETS = 256 };
static compiled *compiled_modules[COMPILED_BUCKETS];

static uint64_t fnv1a(const uint8_t *p, size_t n) {
  uint64_t x = 14695981039346656037ull;
  for (size_t i = 0; i < n; i++) x = (x ^ p[i]) * 1099511628211ull;
  return x;
}

/* The module compiled from bytes, compiling it if no module with the same
 * bytes has been. The module stays in the table: callers do not delete it. */
static wasmtime_error_t *compile(const uint8_t *bytes, size_t len, wasmtime_module_t **out) {
  uint64_t hash = fnv1a(bytes, len);
  compiled **bucket = &compiled_modules[hash % COMPILED_BUCKETS];
  for (compiled *c = *bucket; c; c = c->next)
    if (c->hash == hash && c->len == len && memcmp(c->bytes, bytes, len) == 0) {
      if (p_on()) p_cache_hits++;
      *out = c->module;
      return NULL;
    }
  wasmtime_module_t *module = NULL;
  if (p_on()) {
    p_compiles++;
    p_compiled_bytes += len;
  }
  double started = profiling > 0 ? now() : 0;
  sub_profile_push(P_COMPILE);
  wasmtime_error_t *error = wasmtime_module_new(engine(), bytes, len, &module);
  sub_profile_pop();
  if (profiling > 0 && getenv("SUBHOST_PROFILE")[0] == '2')
    fprintf(stderr, "compile %7zu bytes %6.1f ms  %s\n", len, 1000 * (now() - started), p_naming);
  if (error) return error;
  compiled *c = malloc(sizeof *c);
  c->hash = hash;
  c->len = len;
  c->bytes = malloc(len ? len : 1);
  memcpy(c->bytes, bytes, len);
  c->module = module;
  c->next = *bucket;
  *bucket = c;
  *out = module;
  return NULL;
}

/* ---- instantiation ---------------------------------------------------- */

static int instantiate(sub_host *h, const char *name, size_t name_len, const uint8_t *bytes, size_t len) {
  wasmtime_module_t *module = NULL;
  p_naming = name;
  wasmtime_error_t *error = compile(bytes, len, &module);
  if (error) {
    take_failure(h, "compile", error, NULL);
    return 1;
  }
  wasmtime_instance_t inst;
  wasm_trap_t *trap = NULL;
  sub_profile_push(P_INSTANTIATE);
  error = wasmtime_linker_instantiate(h->linker, h->ctx, module, &inst, &trap);
  sub_profile_pop();
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

/* A module linklet's instance name is "<module>@<phase>+<shift>" (spec 3.2).
 * Compiled linklets import from other linklets by names relative to their
 * own module at phase shift 0; instantiating at phase shift s adds s to each
 * such name.
 * Writes the mapped name to out; other names are copied unchanged. */
static void shift_name(const char *name, size_t len, int32_t shift, char *out, size_t cap) {
  size_t plus = len;
  for (size_t i = len; i > 0; i--)
    if (name[i - 1] == '+') { plus = i - 1; break; }
  bool linklet = plus < len && memchr(name, '@', plus) != NULL && plus + 1 < len;
  for (size_t i = plus + 1; linklet && i < len; i++)
    if (name[i] < '0' || name[i] > '9') linklet = false;
  if (!linklet || shift == 0) {
    snprintf(out, cap, "%.*s", (int)len, name);
    return;
  }
  /* Parse the digits within len: an import name is not NUL-terminated. */
  long t = 0;
  for (size_t i = plus + 1; i < len; i++) t = t * 10 + (name[i] - '0');
  snprintf(out, cap, "%.*s+%ld", (int)plus, name, t + shift);
}

/* The instance an import from mod (len bytes) links to, for the instance
 * named name at phase shift shift. A linklet name, one with an @ in it, is
 * shifted, and if name is "<ns>/<rest>" it is looked up in namespace ns
 * too: a linklet registered in a namespace imports from linklets in it
 * (spec 3.2). Other names, such as "syntax" and "host", are unchanged. */
static void map_import(const char *name, const char *mod, size_t len, int32_t shift, char *out, size_t cap) {
  if (!memchr(mod, '@', len)) {
    snprintf(out, cap, "%.*s", (int)len, mod);
    return;
  }
  const char *slash = strrchr(name, '/');
  int ns = slash ? (int)(slash - name) + 1 : 0;
  snprintf(out, cap, "%.*s", ns, name);
  size_t used = strlen(out);
  shift_name(mod, len, shift, out + used, cap - used);
}

int sub_instantiate_shifted(sub_host *h, const char *name, const uint8_t *bytes, size_t len, int32_t shift) {
  char *name_copy = strdup(name);
  uint8_t *copy = malloc(len ? len : 1);
  memcpy(copy, bytes, len);
  int rc = 1;
  wasmtime_module_t *module = NULL;
  wasm_importtype_vec_t imports = {0};
  wasmtime_extern_t *externs = NULL;
  p_naming = name_copy;
  wasmtime_error_t *error = compile(copy, len, &module);
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
    map_import(name_copy, mod->data, mod->size, shift, mapped, sizeof mapped);
    if (!wasmtime_linker_get(h->linker, h->ctx, mapped, strlen(mapped), field->data, field->size, &externs[i])) {
      set_err(h, "instantiate %s: no import %s.%.*s", name_copy, mapped, (int)field->size, field->data);
      goto done;
    }
  }
  wasmtime_instance_t inst;
  wasm_trap_t *trap = NULL;
  sub_profile_push(P_INSTANTIATE);
  error = wasmtime_instance_new(h->ctx, module, externs, imports.size, &inst, &trap);
  sub_profile_pop();
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
  free(copy);
  free(name_copy);
  return rc;
}

/* ---- calls ------------------------------------------------------------ */

static int call(sub_host *h, const char *inst, const char *fn, int nargs,
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

int sub_call(sub_host *h, const char *inst, const char *fn, int nargs,
             int32_t a0, int32_t a1, int32_t a2, int32_t a3, int32_t a4, int32_t a5) {
  p_enter_wasm();
  int rc = call(h, inst, fn, nargs, a0, a1, a2, a3, a4, a5);
  sub_profile_pop();
  return rc;
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
  int32_t shift = args[4].of.i32;
  if (shift < 0) return trap_msg("host.instantiate: negative phase shift");
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
  /* At a phase shift, and in a namespace, linklet names in the module's
   * imports are mapped (spec 3.2). */
  int rc = shift == 0 && !strchr(name_copy, '/') ? instantiate(h, name_copy, nl, copy, bl)
                                                 : sub_instantiate_shifted(h, name_copy, copy, bl, shift);
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

void sub_add_arg(sub_host *h, const char *arg) {
  h->args = realloc(h->args, (size_t)(h->nargs + 1) * sizeof *h->args);
  h->args[h->nargs++] = strdup(arg);
}

static wasm_trap_t *host_arg_count(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                   size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = h->nargs;
  return NULL;
}

/* Copy at most cap bytes of argument i to buf. Returns its length, or -1
 * if there is no argument i. */
static wasm_trap_t *host_arg(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                             size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  int32_t i = args[0].of.i32;
  uint32_t bp = (uint32_t)args[1].of.i32, cap = (uint32_t)args[2].of.i32;
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = -1;
  if (i < 0 || i >= h->nargs) return NULL;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.arg: caller exports no memory");
  size_t n = strlen(h->args[i]);
  uint32_t k = n < cap ? (uint32_t)n : cap;
  uint8_t *buf = range(wasmtime_caller_context(caller), &mem, bp, k);
  if (!buf) return trap_msg("host.arg: out of bounds");
  memcpy(buf, h->args[i], k);
  results[0].of.i32 = (int32_t)n;
  return NULL;
}

/* The len bytes at ptr in the caller's memory as a C string, which the
 * caller frees, or NULL if they are out of bounds. */
static char *caller_string(wasmtime_caller_t *caller, const wasmtime_memory_t *mem, uint32_t ptr, uint32_t len) {
  uint8_t *p = range(wasmtime_caller_context(caller), mem, ptr, len);
  if (!p) return NULL;
  char *s = malloc((size_t)len + 1);
  memcpy(s, p, len);
  s[len] = '\0';
  return s;
}

/* Read the file named by the path at (path, path-len): copy at most cap of
 * its bytes to buf and return its size, or -1, with error_message saying
 * why. */
static wasm_trap_t *host_read_file(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                   size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  uint32_t pp = (uint32_t)args[0].of.i32, pl = (uint32_t)args[1].of.i32;
  uint32_t bp = (uint32_t)args[2].of.i32, cap = (uint32_t)args[3].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.read_file: caller exports no memory");
  char *path = caller_string(caller, &mem, pp, pl);
  if (!path) return trap_msg("host.read_file: out of bounds");
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = -1;
  FILE *f = fopen(path, "rb");
  long size = -1;
  if (f && fseek(f, 0, SEEK_END) == 0) size = ftell(f);
  if (!f || size < 0) {
    set_err(h, "%s: %s", path, strerror(errno));
  } else if (size > INT32_MAX) {
    set_err(h, "%s: the file is larger than 2 GiB", path);
  } else {
    uint32_t k = (uint32_t)size < cap ? (uint32_t)size : cap;
    uint8_t *buf = range(wasmtime_caller_context(caller), &mem, bp, k);
    if (!buf) {
      fclose(f);
      free(path);
      return trap_msg("host.read_file: out of bounds");
    }
    rewind(f);
    if (fread(buf, 1, k, f) == k)
      results[0].of.i32 = (int32_t)size;
    else
      set_err(h, "%s: %s", path, strerror(errno));
  }
  if (f) fclose(f);
  free(path);
  return NULL;
}

/* Write the len bytes at buf to the file named by the path at (path,
 * path-len), creating or replacing it. Returns 0, or -1 with error_message
 * saying why. */
static wasm_trap_t *host_write_file(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                    size_t nargs, wasmtime_val_t *results, size_t nresults) {
  sub_host *h = env;
  uint32_t pp = (uint32_t)args[0].of.i32, pl = (uint32_t)args[1].of.i32;
  uint32_t bp = (uint32_t)args[2].of.i32, len = (uint32_t)args[3].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.write_file: caller exports no memory");
  char *path = caller_string(caller, &mem, pp, pl);
  uint8_t *buf = range(wasmtime_caller_context(caller), &mem, bp, len);
  if (!path || !buf) {
    free(path);
    return trap_msg("host.write_file: out of bounds");
  }
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = -1;
  FILE *f = fopen(path, "wb");
  if (!f)
    set_err(h, "%s: %s", path, strerror(errno));
  else if (fwrite(buf, 1, len, f) != len || fclose(f) != 0)
    set_err(h, "%s: %s", path, strerror(errno));
  else
    results[0].of.i32 = 0;
  free(path);
  return NULL;
}

/* End the process with status code. */
static wasm_trap_t *host_exit(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                              size_t nargs, wasmtime_val_t *results, size_t nresults) {
  fflush(stdout);
  fflush(stderr);
  exit(args[0].of.i32);
}

/* Expander queries (stage0 only): forward to the embedder's callback. env
 * points at an op code; the host is found through the store's data. */
static const int32_t op_codes[] = {SUB_OP_SYNTAX_LOCAL_VALUE, SUB_OP_RAISE_SYNTAX_ERROR, SUB_OP_FREE_IDENTIFIER_EQ,
                                   SUB_OP_IDENTIFIER_BINDING_KIND, SUB_OP_LOCAL_EXPAND,
                                   SUB_OP_SYNTAX_LOCAL_LIFT_DEFINITION};

static wasm_trap_t *expander_call(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                  size_t nargs, wasmtime_val_t *results, size_t nresults) {
  int32_t op = *(const int32_t *)env;
  sub_host *h = wasmtime_context_get_data(wasmtime_caller_context(caller));
  if (!h->cb) return trap_msg("expander query used outside the expander");
  ENTER(h, caller);
  if (p_on() && op >= 0 && op < 8) p_callbacks[op]++;
  sub_profile_push(P_EMBEDDER);
  int32_t r = h->cb(op, nargs > 0 ? args[0].of.i32 : 0, nargs > 1 ? args[1].of.i32 : 0);
  sub_profile_pop();
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
  h->store = wasmtime_store_new(engine(), h, NULL);
  h->ctx = wasmtime_store_context(h->store);
  h->linker = wasmtime_linker_new(engine());
  if (define(h, "host", "write", 3, 1, host_write, h) ||
      define(h, "host", "trap", 2, 0, host_trap, h) ||
      define(h, "host", "instantiate", 5, 1, host_instantiate, h) ||
      define(h, "host", "export_index", 4, 1, host_export_index, h) ||
      define(h, "host", "error_message", 2, 1, host_error_message, h) ||
      define(h, "host", "arg_count", 0, 1, host_arg_count, h) ||
      define(h, "host", "arg", 3, 1, host_arg, h) ||
      define(h, "host", "read_file", 4, 1, host_read_file, h) ||
      define(h, "host", "write_file", 4, 1, host_write_file, h) ||
      define(h, "host", "exit", 1, 0, host_exit, h) ||
      define(h, "expander", "syntax-local-value", 1, 1, expander_call, (void *)&op_codes[0]) ||
      define(h, "expander", "raise-syntax-error", 2, 1, expander_call, (void *)&op_codes[1]) ||
      define(h, "expander", "free-identifier=?", 2, 1, expander_call, (void *)&op_codes[2]) ||
      define(h, "expander", "identifier-binding-kind", 1, 1, expander_call, (void *)&op_codes[3]) ||
      define(h, "expander", "local-expand", 1, 1, expander_call, (void *)&op_codes[4]) ||
      define(h, "expander", "syntax-local-lift-definition", 1, 1, expander_call, (void *)&op_codes[5])) {
    fprintf(stderr, "subhost: %s\n", h->err);
    abort();
  }
  return h;
}

void sub_host_free(sub_host *h) {
  if (!h) return;
  wasmtime_linker_delete(h->linker);
  wasmtime_store_delete(h->store);
  free(h->pending_trap);
  for (int i = 0; i < h->nargs; i++) free(h->args[i]);
  free(h->args);
  free(h);
}
