/* Lifecycle: permanent.
 *
 * The native host (spec section 4), over the wasmtime C API. It runs
 * programs, the compiler among them; bin/sub uses it by default.
 *
 *   build/subhost DIR [arg ...]
 *
 * runs the program that `sub build` wrote to DIR. DIR/program lists the
 * program's linklets, one per line, each after the ones it imports from;
 * the last is the program's entry. The host instantiates each from
 * DIR/<name>.wasm under its name, then calls the entry's `main`.
 *
 * Exit status: 0 when main returns, or when there is no main; 1 when
 * DIR/program or a linklet's file cannot be read; 2 when a linklet fails
 * to instantiate, or main traps or lets an exception escape; and
 * whatever the program passes to host.exit. A trap's message and
 * backtrace go to stderr, unless the entry exports `on-trap`, which then
 * reports it.
 *
 * The host is one store and one linker. Instances are registered by name
 * and link to each other by name. The host owns no memory: each host
 * import reads and writes the calling instance's own memory. The wasm
 * stack is 4 MiB. */
#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wasm.h>
#include <wasmtime.h>

static struct {
  wasmtime_store_t *store;
  wasmtime_linker_t *linker;
  /* The context every call uses. Inside a host function it is the caller's
   * context, so nested calls into wasm go through the right one. */
  wasmtime_context_t *ctx;
  char **args; /* the program's command-line arguments */
  int nargs;
  char err[8192]; /* the last failure's message */
} host;

static void set_err(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(host.err, sizeof host.err, fmt, ap);
  va_end(ap);
}

/* ---- source locations ------------------------------------------------- */

/* A module's source-locations section (docs/spec.md section 3.6) maps code
 * offsets to where the code comes from. A trap's frames name their module
 * by the module name its name section gives, so the tables are kept by
 * that name. */
typedef struct location_table {
  char *module;
  size_t n, nfiles, nfuncs;
  uint32_t *at, *file, *line, *col;
  char **files;
  char **funcs;                 /* function names, by index, from the name section */
  struct location_table *next;
} location_table;

static location_table *location_tables;

static uint32_t read_u32(const uint8_t *p, size_t end, size_t *pos) {
  uint32_t n = 0;
  for (int shift = 0; *pos < end && shift < 35; shift += 7) {
    uint8_t b = p[(*pos)++];
    n |= (uint32_t)(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
  }
  return n;
}

static char *read_name(const uint8_t *p, size_t end, size_t *pos) {
  uint32_t n = read_u32(p, end, pos);
  if (*pos + n > end) n = (uint32_t)(end - *pos);
  char *s = strndup((const char *)p + *pos, n);
  *pos += n;
  return s;
}

static void note_locations(const uint8_t *bytes, size_t len) {
  const uint8_t *sec = NULL;
  size_t sec_end = 0, sec_pos = 0, funcs_pos = 0, funcs_end = 0;
  char *module = NULL;
  for (size_t pos = 8; pos < len;) {
    uint8_t id = bytes[pos++];
    size_t size = read_u32(bytes, len, &pos), end = pos + size;
    if (end > len) break;
    if (id == 0) {
      size_t q = pos;
      char *name = read_name(bytes, end, &q);
      if (strcmp(name, "name") == 0) {
        while (q < end) {
          uint8_t sub = bytes[q++];
          size_t sub_end = read_u32(bytes, end, &q);
          sub_end += q;
          if (sub == 0 && !module) module = read_name(bytes, sub_end, &q);
          if (sub == 1) {
            funcs_pos = q;
            funcs_end = sub_end;
          }
          q = sub_end;
        }
      } else if (strcmp(name, "source-locations") == 0) {
        sec = bytes;
        sec_pos = q;
        sec_end = end;
      }
      free(name);
    }
    pos = end;
  }
  if (!module) return;
  location_table *t = calloc(1, sizeof *t);
  t->module = module;
  if (!sec) {
    sec = bytes;
    sec_pos = sec_end = 0;
  }
  t->nfiles = read_u32(sec, sec_end, &sec_pos);
  t->files = calloc(t->nfiles ? t->nfiles : 1, sizeof *t->files);
  for (size_t i = 0; i < t->nfiles; i++) t->files[i] = read_name(sec, sec_end, &sec_pos);
  t->n = read_u32(sec, sec_end, &sec_pos);
  t->at = calloc(t->n ? t->n : 1, sizeof *t->at);
  t->file = calloc(t->n ? t->n : 1, sizeof *t->file);
  t->line = calloc(t->n ? t->n : 1, sizeof *t->line);
  t->col = calloc(t->n ? t->n : 1, sizeof *t->col);
  uint32_t at = 0;
  for (size_t i = 0; i < t->n; i++) {
    at += read_u32(sec, sec_end, &sec_pos);
    t->at[i] = at;
    t->file[i] = read_u32(sec, sec_end, &sec_pos);
    t->line[i] = read_u32(sec, sec_end, &sec_pos);
    t->col[i] = read_u32(sec, sec_end, &sec_pos);
  }
  if (funcs_end > funcs_pos) {
    uint32_t count = read_u32(bytes, funcs_end, &funcs_pos);
    for (uint32_t i = 0; i < count && funcs_pos < funcs_end; i++) {
      uint32_t index = read_u32(bytes, funcs_end, &funcs_pos);
      char *name = read_name(bytes, funcs_end, &funcs_pos);
      if (index >= t->nfuncs) {
        size_t n = index + 1;
        t->funcs = realloc(t->funcs, n * sizeof *t->funcs);
        for (size_t j = t->nfuncs; j < n; j++) t->funcs[j] = NULL;
        t->nfuncs = n;
      }
      t->funcs[index] = name;
    }
  }
  t->next = location_tables;
  location_tables = t;
}

static location_table *table_of(const char *module, size_t module_len) {
  for (location_table *t = location_tables; t; t = t->next)
    if (strlen(t->module) == module_len && memcmp(t->module, module, module_len) == 0) return t;
  return NULL;
}

/* "file:line:col" for the code at offset in the module named module, or
 * "" if its table has no location for it. */
static const char *location_of(const char *module, size_t module_len, size_t offset, char *buf, size_t cap) {
  location_table *t = table_of(module, module_len);
  if (t) {
    size_t lo = 0, hi = t->n;
    while (lo < hi) {
      size_t mid = (lo + hi) / 2;
      if (t->at[mid] <= offset) lo = mid + 1;
      else hi = mid;
    }
    if (lo == 0 || t->line[lo - 1] == 0 || t->file[lo - 1] >= t->nfiles) return "";
    snprintf(buf, cap, "  %s:%u:%u", t->files[t->file[lo - 1]], t->line[lo - 1], t->col[lo - 1] + 1);
    return buf;
  }
  return "";
}

/* A backtrace, a line per frame, with each frame's source location. */
static void backtrace_of(wasm_frame_vec_t frames, char *out, size_t cap) {
  size_t used = 0;
  out[0] = '\0';
  for (size_t i = 0; i < frames.size && used < cap; i++) {
    const wasm_frame_t *f = frames.data[i];
    /* Each name is copied at once: the next call may reuse its memory. */
    const wasm_name_t *name = wasmtime_frame_module_name(f);
    char *m = name ? strndup(name->data, name->size) : strdup("?");
    location_table *t = table_of(m, strlen(m));
    uint32_t index = wasm_frame_func_index(f);
    const char *fn = t && index < t->nfuncs && t->funcs[index] ? t->funcs[index] : "?";
    size_t offset = wasm_frame_module_offset(f);
    char where[512];
    used += (size_t)snprintf(out + used, cap - used, "%s    %zu: 0x%zx - %s!%s%s", i ? "\n" : "", i, offset, m, fn,
                             location_of(m, strlen(m), offset, where, sizeof where));
    free(m);
  }
}

/* Record a wasmtime error or trap as the last error; consumes it. */
static void take_failure(const char *what, wasmtime_error_t *error, wasm_trap_t *trap) {
  wasm_frame_vec_t frames = {0};
  if (error) wasmtime_error_wasm_trace(error, &frames);
  else if (trap) wasm_trap_trace(trap, &frames);
  if (frames.size > 0) {
    /* The cause, then the backtrace, with source locations. The frames
     * borrow from the error or trap, which is deleted after them. */
    wasm_byte_vec_t msg = {0};
    if (error) wasmtime_error_message(error, &msg);
    else wasm_trap_message(trap, &msg);
    int n = (int)msg.size;
    while (n > 0 && msg.data[n - 1] == '\0') n--;
    char *text = strndup(msg.data ? msg.data : "", (size_t)n);
    wasm_byte_vec_delete(&msg);
    const char *marker = "\n\nCaused by:\n";
    char *caused = strstr(text, marker);
    const char *cause = caused ? caused + strlen(marker) : text;
    while (*cause == ' ') cause++;
    for (size_t k = strlen(text); k > 0 && (text[k - 1] == '\n' || text[k - 1] == ' '); k--) text[k - 1] = '\0';
    char trace[sizeof host.err];
    backtrace_of(frames, trace, sizeof trace);
    wasm_frame_vec_delete(&frames);
    if (error) wasmtime_error_delete(error);
    else wasm_trap_delete(trap);
    set_err("%s: %s\n%s", what, cause, trace);
    free(text);
    return;
  }
  wasm_frame_vec_delete(&frames);
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
    set_err("%s: %s\n%s", what, cause, context);
  } else {
    set_err("%s: %s", what, text);
  }
  free(text);
}

/* Whether a failed call or instantiation failed because an exception
 * escaped it, rather than a trap. The exception stays pending on the
 * store, and the error or trap is deleted. */
static bool uncaught(wasmtime_error_t *error, wasm_trap_t *trap) {
  if (!wasmtime_context_has_exception(host.ctx)) return false;
  if (error) wasmtime_error_delete(error);
  if (trap) wasm_trap_delete(trap);
  return true;
}

/* Take the pending exception off the store, reported as the last error. */
static void drop_exception(const char *what) {
  wasmtime_exnref_t exn;
  if (wasmtime_context_take_exception(host.ctx, &exn)) wasmtime_exnref_unroot(&exn);
  set_err("%s", what);
}

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

/* ---- compiled modules ------------------------------------------------- */

static wasm_engine_t *the_engine;

static wasm_engine_t *engine(void) {
  if (!the_engine) {
    wasm_config_t *config = wasm_config_new();
    wasmtime_config_wasm_tail_call_set(config, true);
    wasmtime_config_wasm_multi_value_set(config, true);
    wasmtime_config_wasm_bulk_memory_set(config, true);
    wasmtime_config_wasm_reference_types_set(config, true);
    wasmtime_config_wasm_function_references_set(config, true);
    wasmtime_config_wasm_gc_set(config, true);
    wasmtime_config_wasm_exceptions_set(config, true);
    /* With SUBHOST_PERFMAP set, wasmtime writes /tmp/perf-PID.map, which
     * names compiled wasm functions in perf's samples. */
    if (getenv("SUBHOST_PERFMAP"))
      wasmtime_config_profiler_set(config, WASMTIME_PROFILING_STRATEGY_PERFMAP);
    /* max_wasm_stack may not exceed async_stack_size, even without async. */
    wasmtime_config_async_stack_size_set(config, (size_t)8 << 20);
    wasmtime_config_max_wasm_stack_set(config, (size_t)4 << 20);
    the_engine = wasm_engine_new_with_config(config);
  }
  return the_engine;
}

/* Every module compiled so far, by its bytes. The compiler instantiates a
 * linklet in the namespace of each compilation that needs it (spec 3.2),
 * and it is compiled once. */
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
      *out = c->module;
      return NULL;
    }
  wasmtime_module_t *module = NULL;
  wasmtime_error_t *error = wasmtime_module_new(engine(), bytes, len, &module);
  if (error) return error;
  note_locations(bytes, len);
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

/* The instance an import from module mod (len bytes) links to: the one
 * map names for mod, or mod itself. map is pairs of names, a module's then
 * its instance's, each followed by a zero byte (spec 4). */
static void mapped_import(const char *map, size_t map_len, const char *mod, size_t len, char *out, size_t cap) {
  for (size_t i = 0; i < map_len;) {
    const char *from = map + i;
    size_t fl = strnlen(from, map_len - i);
    if (i + fl + 1 >= map_len) break;
    const char *to = from + fl + 1;
    size_t tl = strnlen(to, map_len - i - fl - 1);
    if (fl == len && memcmp(from, mod, len) == 0) {
      snprintf(out, cap, "%.*s", (int)tl, to);
      return;
    }
    i += fl + 1 + tl + 1;
  }
  snprintf(out, cap, "%.*s", (int)len, mod);
}

/* Compile and instantiate the module in bytes, link each import to the
 * instance map names for its module, or to the instance of that name, and
 * register it as name. 0 on success; 2 if an exception escaped the
 * module's start function, which is left pending on the store; 1 on any
 * other failure. The arguments must not be in wasm memory: instantiation
 * runs the start function, which may move it. */
static int instantiate(const char *name, size_t name_len, const uint8_t *bytes, size_t len,
                       const char *map, size_t map_len) {
  int rc = 1;
  wasmtime_module_t *module = NULL;
  wasm_importtype_vec_t imports = {0};
  wasmtime_extern_t *externs = NULL;
  wasmtime_error_t *error = compile(bytes, len, &module);
  if (error) {
    take_failure("compile", error, NULL);
    goto done;
  }
  wasmtime_module_imports(module, &imports);
  externs = calloc(imports.size ? imports.size : 1, sizeof *externs);
  for (size_t i = 0; i < imports.size; i++) {
    const wasm_name_t *mod = wasm_importtype_module(imports.data[i]);
    const wasm_name_t *field = wasm_importtype_name(imports.data[i]);
    char linked[512];
    mapped_import(map, map_len, mod->data, mod->size, linked, sizeof linked);
    if (!wasmtime_linker_get(host.linker, host.ctx, linked, strlen(linked), field->data, field->size, &externs[i])) {
      set_err("instantiate %.*s: no import %s.%.*s", (int)name_len, name, linked, (int)field->size, field->data);
      goto done;
    }
  }
  wasmtime_instance_t inst;
  wasm_trap_t *trap = NULL;
  error = wasmtime_instance_new(host.ctx, module, externs, imports.size, &inst, &trap);
  if (error || trap) {
    if (uncaught(error, trap))
      rc = 2;
    else
      take_failure("instantiate", error, trap);
    goto done;
  }
  error = wasmtime_linker_define_instance(host.linker, host.ctx, name, name_len, &inst);
  if (error) {
    take_failure("register", error, NULL);
    goto done;
  }
  rc = 0;
done:
  free(externs);
  wasm_importtype_vec_delete(&imports);
  return rc;
}

/* Call the function inst exports as fn, which takes no arguments. 0 on
 * success. */
static int call(const char *inst, const char *fn) {
  wasmtime_extern_t ext;
  if (!wasmtime_linker_get(host.linker, host.ctx, inst, strlen(inst), fn, strlen(fn), &ext) ||
      ext.kind != WASMTIME_EXTERN_FUNC) {
    set_err("call: no function %s.%s", inst, fn);
    return 1;
  }
  wasmtime_func_t func = ext.of.func;
  wasm_functype_t *ty = wasmtime_func_type(host.ctx, &func);
  size_t nparams = wasm_functype_params(ty)->size;
  size_t nresults = wasm_functype_results(ty)->size;
  wasm_functype_delete(ty);
  if (nparams != 0 || nresults > 1) {
    set_err("call: %s.%s takes %zu arguments and returns %zu values", inst, fn, nparams, nresults);
    return 1;
  }
  wasmtime_val_t res[1];
  wasm_trap_t *trap = NULL;
  wasmtime_error_t *error = wasmtime_func_call(host.ctx, &func, NULL, 0, res, nresults, &trap);
  if (error || trap) {
    if (uncaught(error, trap))
      drop_exception("uncaught exception");
    else
      take_failure("trap", error, trap);
    return 1;
  }
  return 0;
}

/* ---- host imports ----------------------------------------------------- */
/* Every pointer a host import receives is into the caller's own memory,
 * the one it exports as "memory" (spec section 4). */

/* Run a host function body with host.ctx set to the caller's context. */
#define ENTER(caller) wasmtime_context_t *saved_ctx = host.ctx; host.ctx = wasmtime_caller_context(caller)
#define LEAVE() host.ctx = saved_ctx

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
  uint32_t np = (uint32_t)args[0].of.i32, nl = (uint32_t)args[1].of.i32;
  uint32_t bp = (uint32_t)args[2].of.i32, bl = (uint32_t)args[3].of.i32;
  uint32_t mp = (uint32_t)args[4].of.i32, ml = (uint32_t)args[5].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.instantiate: caller exports no memory");
  wasmtime_context_t *cctx = wasmtime_caller_context(caller);
  uint8_t *name = range(cctx, &mem, np, nl), *bytes = range(cctx, &mem, bp, bl), *map = range(cctx, &mem, mp, ml);
  if (!name || !bytes || !map) return trap_msg("host.instantiate: out of bounds");
  /* Copy out before instantiating: the new module's start function may
   * grow the caller's memory and move it. */
  char *name_copy = malloc(nl + 1);
  memcpy(name_copy, name, nl);
  name_copy[nl] = '\0';
  uint8_t *copy = malloc(bl ? bl : 1);
  memcpy(copy, bytes, bl);
  char *map_copy = malloc(ml ? ml : 1);
  memcpy(map_copy, map, ml);
  ENTER(caller);
  int rc = instantiate(name_copy, nl, copy, bl, map_copy, ml);
  LEAVE();
  free(map_copy);
  free(copy);
  free(name_copy);
  /* An exception out of the start function goes on to the caller (spec 4). */
  if (rc == 2) {
    wasmtime_exnref_t exn;
    wasmtime_context_take_exception(cctx, &exn);
    wasm_trap_t *rethrow = wasmtime_context_set_exception(cctx, &exn);
    wasmtime_exnref_unroot(&exn);
    return rethrow;
  }
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = rc;
  return NULL;
}

/* Append inst.field to the caller's table (exported as "table"). */
static wasm_trap_t *host_export_index(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                      size_t nargs, wasmtime_val_t *results, size_t nresults) {
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
  if (wasmtime_linker_get(host.linker, cctx, (const char *)inst, il, (const char *)field, fl, &ext) &&
      ext.kind == WASMTIME_EXTERN_FUNC) {
    wasmtime_val_t init = {.kind = WASMTIME_FUNCREF};
    init.of.funcref = ext.of.func;
    uint64_t prev = 0;
    wasmtime_error_t *error = wasmtime_table_grow(cctx, &table.of.table, 1, &init, &prev);
    if (error)
      take_failure("host.export_index", error, NULL);
    else
      index = (int32_t)prev;
  }
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = index;
  return NULL;
}

static wasm_trap_t *host_error_message(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                       size_t nargs, wasmtime_val_t *results, size_t nresults) {
  uint32_t bp = (uint32_t)args[0].of.i32, cap = (uint32_t)args[1].of.i32;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.error_message: caller exports no memory");
  size_t n = strlen(host.err);
  if (n > cap) n = cap;
  uint8_t *buf = range(wasmtime_caller_context(caller), &mem, bp, (uint32_t)n);
  if (buf) memcpy(buf, host.err, n);
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = buf ? (int32_t)n : -1;
  return NULL;
}

static wasm_trap_t *host_arg_count(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                   size_t nargs, wasmtime_val_t *results, size_t nresults) {
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = host.nargs;
  return NULL;
}

/* Copy at most cap bytes of argument i to buf. Returns its length, or -1
 * if there is no argument i. */
static wasm_trap_t *host_arg(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                             size_t nargs, wasmtime_val_t *results, size_t nresults) {
  int32_t i = args[0].of.i32;
  uint32_t bp = (uint32_t)args[1].of.i32, cap = (uint32_t)args[2].of.i32;
  results[0].kind = WASMTIME_I32;
  results[0].of.i32 = -1;
  if (i < 0 || i >= host.nargs) return NULL;
  wasmtime_memory_t mem;
  if (!caller_memory(caller, &mem)) return trap_msg("host.arg: caller exports no memory");
  size_t n = strlen(host.args[i]);
  uint32_t k = n < cap ? (uint32_t)n : cap;
  uint8_t *buf = range(wasmtime_caller_context(caller), &mem, bp, k);
  if (!buf) return trap_msg("host.arg: out of bounds");
  memcpy(buf, host.args[i], k);
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
    set_err("%s: %s", path, strerror(errno));
  } else if (size > INT32_MAX) {
    set_err("%s: the file is larger than 2 GiB", path);
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
      set_err("%s: %s", path, strerror(errno));
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
    set_err("%s: %s", path, strerror(errno));
  else if (fwrite(buf, 1, len, f) != len || fclose(f) != 0)
    set_err("%s: %s", path, strerror(errno));
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

/* Define host.name, taking np i32s and returning nr. */
static void define(const char *name, int np, int nr, wasmtime_func_callback_t cb) {
  wasm_functype_t *ty = i32_functype(np, nr);
  wasmtime_error_t *error =
      wasmtime_linker_define_func(host.linker, "host", 4, name, strlen(name), ty, cb, NULL, NULL);
  wasm_functype_delete(ty);
  if (error) {
    take_failure("define", error, NULL);
    fprintf(stderr, "subhost: %s\n", host.err);
    abort();
  }
}

static void start_host(void) {
  host.store = wasmtime_store_new(engine(), NULL, NULL);
  host.ctx = wasmtime_store_context(host.store);
  /* A compile keeps every instance it makes, one per compile-time linklet;
     a big module makes more than the store's default limit of 10000. */
  wasmtime_store_limiter(host.store, -1, -1, 1000000, -1, -1);
  host.linker = wasmtime_linker_new(engine());
  define("write", 3, 1, host_write);
  define("trap", 2, 0, host_trap);
  define("instantiate", 6, 1, host_instantiate);
  define("export_index", 4, 1, host_export_index);
  define("error_message", 2, 1, host_error_message);
  define("arg_count", 0, 1, host_arg_count);
  define("arg", 3, 1, host_arg);
  define("read_file", 4, 1, host_read_file);
  define("write_file", 4, 1, host_write_file);
  define("exit", 1, 0, host_exit);
}

/* ---- running a program ------------------------------------------------ */

/* The whole file at path, or NULL; its length in *len. */
static char *read_all(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  char *buf = NULL;
  long size = -1;
  if (fseek(f, 0, SEEK_END) == 0) size = ftell(f);
  if (size >= 0 && fseek(f, 0, SEEK_SET) == 0) {
    buf = malloc((size_t)size + 1);
    if (fread(buf, 1, (size_t)size, f) == (size_t)size) {
      buf[size] = '\0';
      *len = (size_t)size;
    } else {
      free(buf);
      buf = NULL;
    }
  }
  fclose(f);
  return buf;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: subhost DIR [arg ...]\n");
    return 64;
  }
  const char *dir = argv[1];
  char path[4096];
  size_t len;
  snprintf(path, sizeof path, "%s/program", dir);
  char *program = read_all(path, &len);
  if (!program) {
    fprintf(stderr, "subhost: cannot read %s\n", path);
    return 1;
  }
  start_host();
  host.args = argv + 2;
  host.nargs = argc - 2;
  const char *last = NULL;
  for (char *name = strtok(program, "\n"); name; name = strtok(NULL, "\n")) {
    snprintf(path, sizeof path, "%s/%s.wasm", dir, name);
    char *bytes = read_all(path, &len);
    if (!bytes) {
      fprintf(stderr, "subhost: cannot read %s\n", path);
      return 1;
    }
    int rc = instantiate(name, strlen(name), (const uint8_t *)bytes, len, "", 0);
    free(bytes);
    if (rc == 2) drop_exception("instantiate: uncaught exception");
    if (rc) {
      fprintf(stderr, "error: %s\n", host.err);
      return 2;
    }
    last = name;
  }
  if (!last) {
    fprintf(stderr, "subhost: %s names no linklets\n", path);
    return 1;
  }
  if (call(last, "main")) {
    /* A program without main has nothing to run. */
    if (strncmp(host.err, "call: no function", 17) == 0) return 0;
    /* A program's on-trap, if it has one, reports the trap (spec 4): the
     * trap's message is the host's last error message, which it reads with
     * host.error_message. If it has none, or traps too, the host reports
     * the trap itself. */
    char *trap = strdup(host.err);
    if (call(last, "on-trap")) fprintf(stderr, "error: %s\n", trap);
    free(trap);
    return 2;
  }
  return 0;
}
