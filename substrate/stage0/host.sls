;; FFI to host/subhost.c. One Scheme `host` is one wasm store. Everything
;; crossing this boundary is an i32: stage0 refers to GC objects in the
;; syntax library through integer handles (spec appendix A).
(library (stage0 host)
  (export host-new host-instantiate! host-instantiate-shifted! host-call host-set-callback! host-request-trap!
          wasm-failure? wasm-failure-message)
  (import (chezscheme))

  (define loaded
    (let ([lib (or (getenv "SUBHOST_LIB") "build/libsubhost.so")])
      (load-shared-object lib)))

  (define c-host-new (foreign-procedure "sub_host_new" () uptr))
  (define c-last-error (foreign-procedure "sub_last_error" (uptr) string))
  (define c-instantiate (foreign-procedure "sub_instantiate" (uptr string u8* size_t) int))
  (define c-instantiate-shifted (foreign-procedure "sub_instantiate_shifted" (uptr string u8* size_t int) int))
  (define c-call (foreign-procedure "sub_call" (uptr string string int int int int int int int) int))
  (define c-result (foreign-procedure "sub_result" (uptr) int))
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

  (define (host-instantiate-shifted! h name bytes shift)
    (check h (c-instantiate-shifted h name bytes (bytevector-length bytes) shift)))

  (define (pad args n)
    (let loop ([args args] [n n])
      (if (zero? n) '() (cons (if (pair? args) (car args) 0) (loop (if (pair? args) (cdr args) '()) (- n 1))))))

  ;; Call inst.fn with i32 arguments; returns the i32 result (0 if none).
  (define (host-call h inst fn . args)
    (check h (apply c-call h inst fn (length args) (pad args 6)))
    (c-result h))

  ;; proc: (op a0 a1) -> i32. The callable is locked so the collector
  ;; cannot move it while C holds its entry point.
  (define (host-set-callback! h proc)
    (let ([code (foreign-callable proc (int int int) int)])
      (lock-object code)
      (c-set-callback h (foreign-callable-entry-point code))))

  (define (host-request-trap! h msg) (c-request-trap h msg)))
