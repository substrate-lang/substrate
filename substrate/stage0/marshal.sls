;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Copy syntax between Chez and the syntax library's GC objects.
;;
;; Stage0 cannot hold wasm GC references in Chez, so it refers to them
;; through integer handles into a table kept by the syntax library (the
;; embedder interface, spec appendix A). Handle 0 is #f. Handles made while
;; a macro runs are released when it returns (see handle-mark). A value
;; crosses in bulk, in the format of quoted data (serialize.sls), through a
;; buffer in the library's memory.
(library (stage0 marshal)
  (export make-store store? store-host encode decode handle-mark handle-release!
          make-wasm-value wasm-value? wasm-value-handle)
  (import (chezscheme) (stage0 syntax) (stage0 host) (stage0 serialize))

  (define-record-type store (fields host))

  ;; A value with no Chez counterpart, kept as its handle.
  (define-record-type wasm-value (fields handle))

  (define (lib st name . args) (apply host-call (store-host st) "syntax" name args))

  (define (handle-mark st) (lib st "%handle-mark"))
  (define (handle-release! st mark) (lib st "%handle-release" mark))

  ;; A Chez datum -> a handle.
  (define (encode st d)
    (if (eq? d #f)
        0
        (with-profile 'marshal
          (lambda ()
            (let* ([s (make-serializer
                       (lambda (v)
                         (if (wasm-value? v)
                             (wasm-value-handle v)
                             (error 'encode "cannot represent this value in the syntax library" v))))]
                   [root (serialize! s d)]
                   [bv (serializer-bytes s)])
              (host-memory-write! (store-host st) "syntax" (lib st "%h-buffer" (bytevector-length bv)) bv)
              (lib st "%h-deserialize" (bytevector-length bv) root))))))

  ;; A handle -> a Chez datum.
  (define (decode st h)
    (if (zero? h)
        #f
        (with-profile 'marshal
          (lambda ()
            (let ([n (lib st "%h-serialize" h)])
              (deserialize (host-memory-read (store-host st) "syntax" (lib st "%h-buffer" 0) n)
                           make-wasm-value)))))))
