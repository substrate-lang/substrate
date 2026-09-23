;; FFI to host/subhost.c. One Scheme `host` is one wasm store.
(library (stage0 host)
  (export host-new host-instantiate! host-call host-call-index
          host-mem-u8 host-mem-i32 host-mem-write! host-set-callback! host-request-trap!
          wasm-failure? wasm-failure-message)
  (import (chezscheme))

  (define loaded
    (let ([lib (or (getenv "SUBHOST_LIB") "build/libsubhost.so")])
      (load-shared-object lib)))

  (define c-host-new (foreign-procedure "sub_host_new" () uptr))
  (define c-last-error (foreign-procedure "sub_last_error" (uptr) string))
  (define c-instantiate (foreign-procedure "sub_instantiate" (uptr string u8* size_t) int))
  (define c-call (foreign-procedure "sub_call" (uptr string string int int int int int int int) int))
  (define c-call-index (foreign-procedure "sub_call_index" (uptr int int int int int) int))
  (define c-result (foreign-procedure "sub_result" (uptr) int))
  (define c-mem-base (foreign-procedure "sub_mem_base" (uptr) uptr))
  (define c-mem-size (foreign-procedure "sub_mem_size" (uptr) size_t))
  (define c-mem-write (foreign-procedure "sub_mem_write" (uptr unsigned-32 u8* size_t) int))
  (define c-set-callback (foreign-procedure "sub_set_callback" (uptr uptr) void))
  (define c-request-trap (foreign-procedure "sub_request_trap" (uptr string) void))

  (define-condition-type &wasm-failure &error make-wasm-failure wasm-failure?
    (text wasm-failure-message))

  (define (check h rc)
    (unless (zero? rc)
      (raise (condition (make-wasm-failure (c-last-error h))))))

  (define (host-new) (c-host-new))

  (define (host-instantiate! h name bytes)
    (check h (c-instantiate h name bytes (bytevector-length bytes))))

  (define (pad args n)
    (let loop ([args args] [n n])
      (if (zero? n) '() (cons (if (pair? args) (car args) 0) (loop (if (pair? args) (cdr args) '()) (- n 1))))))

  ;; Call inst.fn with i32 arguments; returns the i32 result (0 if none).
  (define (host-call h inst fn . args)
    (check h (apply c-call h inst fn (length args) (pad args 6)))
    (c-result h))

  (define (host-call-index h index . args)
    (check h (apply c-call-index h index (length args) (pad args 3)))
    (c-result h))

  (define (host-mem-u8 h addr)
    (unless (< addr (c-mem-size h)) (error 'host-mem-u8 "out of bounds" addr))
    (foreign-ref 'unsigned-8 (c-mem-base h) addr))

  (define (host-mem-i32 h addr)
    (unless (<= (+ addr 4) (c-mem-size h)) (error 'host-mem-i32 "out of bounds" addr))
    (foreign-ref 'integer-32 (c-mem-base h) addr))

  (define (host-mem-write! h addr bv)
    (check h (c-mem-write h addr bv (bytevector-length bv))))

  ;; proc: (op a0 a1) -> i32. The callable is locked so the collector
  ;; cannot move it while C holds its entry point.
  (define (host-set-callback! h proc)
    (let ([code (foreign-callable proc (int int int) int)])
      (lock-object code)
      (c-set-callback h (foreign-callable-entry-point code))))

  (define (host-request-trap! h msg) (c-request-trap h msg)))
