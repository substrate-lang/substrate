;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; FFI to host/subhost.c. One Scheme `host` is one wasm store. Everything
;; crossing this boundary is an i32: stage0 refers to GC objects in the
;; syntax library through integer handles (spec appendix A).
(library (stage0 host)
  (export with-profile host-new host-instantiate! host-call host-memory-write! host-memory-read
          host-set-callback! host-request-trap! host-add-arg!
          wasm-failure? wasm-failure-message)
  (import (chezscheme))

  (define loaded
    (let ([lib (or (getenv "SUBHOST_LIB") "build/libsubhost.so")])
      (load-shared-object lib)))

  (define c-host-new (foreign-procedure "sub_host_new" () uptr))
  (define c-last-error (foreign-procedure "sub_last_error" (uptr) string))
  (define c-instantiate (foreign-procedure "sub_instantiate" (uptr string u8* size_t u8* size_t) int))
  (define c-call (foreign-procedure "sub_call" (uptr string string int int int int int int int) int))
  (define c-result (foreign-procedure "sub_result" (uptr) int))
  (define c-memory-write (foreign-procedure "sub_memory_write" (uptr string unsigned-32 u8* size_t) int))
  (define c-memory-read (foreign-procedure "sub_memory_read" (uptr string unsigned-32 u8* size_t) int))
  (define c-set-callback (foreign-procedure "sub_set_callback" (uptr uptr) void))
  (define c-request-trap (foreign-procedure "sub_request_trap" (uptr string) void))
  (define c-add-arg (foreign-procedure "sub_add_arg" (uptr string) void))
  (define c-profile-push (foreign-procedure "sub_profile_push" (int) void))
  (define c-profile-pop (foreign-procedure "sub_profile_pop" () void))

  ;; Run thunk as stage0 work of the given category, for the host's profile
  ;; (SUBHOST_PROFILE, host/subhost.h).
  (define profiling? (and (getenv "SUBHOST_PROFILE") #t))
  (define (with-profile category thunk)
    (if profiling?
        (dynamic-wind
          (lambda () (c-profile-push (+ 4 (case category [(marshal) 0] [(codegen) 1] [(read) 2]))))
          thunk
          c-profile-pop)
        (thunk)))

  (define-condition-type &wasm-failure &error make-wasm-failure wasm-failure?
    (text wasm-failure-message))

  (define (check h rc)
    (unless (zero? rc)
      (raise (condition (make-wasm-failure (c-last-error h))))))

  (define (host-new) (c-host-new))

  ;; Give the program run in h a command-line argument (spec 4).
  (define (host-add-arg! h arg) (c-add-arg h arg))

  ;; Instantiate bytes as instance name, linking an import from a module
  ;; that the alist imports names to its instance there (spec 4).
  (define (host-instantiate! h name bytes . imports)
    (let ([m (string->utf8 (apply string-append
                                  (map (lambda (p) (string-append (car p) "\x0;" (cdr p) "\x0;"))
                                       (if (null? imports) '() (car imports)))))])
      (check h (c-instantiate h name bytes (bytevector-length bytes) m (bytevector-length m)))))

  (define (pad args n)
    (let loop ([args args] [n n])
      (if (zero? n) '() (cons (if (pair? args) (car args) 0) (loop (if (pair? args) (cdr args) '()) (- n 1))))))

  ;; Call inst.fn with i32 arguments; returns the i32 result (0 if none).
  (define (host-call h inst fn . args)
    (check h (apply c-call h inst fn (length args) (pad args 6)))
    (c-result h))

  ;; Copy bytevector bv to address addr of instance inst's memory, or len
  ;; bytes from there to a new bytevector.
  (define (host-memory-write! h inst addr bv)
    (check h (c-memory-write h inst addr bv (bytevector-length bv))))

  (define (host-memory-read h inst addr len)
    (let ([bv (make-bytevector len)])
      (check h (c-memory-read h inst addr bv len))
      bv))

  ;; proc: (op a0 a1) -> i32. The callable is locked so the collector
  ;; cannot move it while C holds its entry point.
  (define (host-set-callback! h proc)
    (let ([code (foreign-callable proc (int int int) int)])
      (lock-object code)
      (c-set-callback h (foreign-callable-entry-point code))))

  (define (host-request-trap! h msg) (c-request-trap h msg)))
