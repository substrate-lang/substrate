;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Copy syntax between Chez and the syntax library's GC objects.
;;
;; Stage0 cannot hold wasm GC references in Chez, so it refers to them
;; through integer handles into a table kept by the syntax library, and
;; builds and takes apart objects with the library's embedder functions
;; (the %h- functions, spec appendix A). Handle 0 is #f. Handles made while
;; a macro runs are released when it returns (see handle-mark).
(library (stage0 marshal)
  (export make-store store? store-host encode decode handle-mark handle-release!
          make-wasm-value wasm-value? wasm-value-handle)
  (import (chezscheme) (stage0 syntax) (stage0 host) (stage0 compile))

  (define-record-type store (fields host))

  ;; A value with no Chez counterpart, kept as its handle.
  (define-record-type wasm-value (fields handle))

  (define (lib st name . args) (apply host-call (store-host st) "syntax" name args))

  (define (handle-mark st) (lib st "%handle-mark"))
  (define (handle-release! st mark) (lib st "%handle-release" mark))

  (define (encode-string st s)
    (let* ([bv (string->utf8 s)]
           [h (lib st "%h-make-string" (bytevector-length bv))])
      (do ([i 0 (+ i 1)]) ((= i (bytevector-length bv)) h)
        (lib st "%h-string-set!" h i (bytevector-u8-ref bv i)))))

  ;; A Chez datum -> a handle.
  (define (encode st d)
    (cond [(and (integer? d) (exact? d))
           (unless (<= fixnum-min d fixnum-max) (error 'encode "integer outside the fixnum range" d))
           (lib st "%h-fixnum" d)]
          [(eq? d #f) 0]
          [(eq? d #t) (lib st "%h-true")]
          [(null? d) (lib st "%h-nil")]
          [(char? d) (lib st "%h-char" (char->integer d))]
          [(string? d) (encode-string st d)]
          [(symbol? d) (lib st "%h-intern" (encode-string st (symbol->string d)))]
          [(pair? d) (let* ([a (encode st (car d))] [b (encode st (cdr d))]) (lib st "%h-cons" a b))]
          [(stx? d)
           (let* ([e (encode st (stx-e d))]
                  [scopes (encode st (stx-scopes d))]
                  [loc (encode st (stx-srcloc d))]
                  [props (encode st (stx-props d))])
             (lib st "%h-syntax" e scopes loc props))]
          [(srcloc? d)
           (lib st "%h-srcloc" (encode st (srcloc-source d))
                (srcloc-line d) (srcloc-col d) (srcloc-pos d) (srcloc-span d))]
          [(wasm-value? d) (wasm-value-handle d)]
          [else (error 'encode "cannot represent this value in the syntax library" d)]))

  (define (decode-string st h)
    (let* ([n (lib st "%h-string-length" h)] [bv (make-bytevector n)])
      (do ([i 0 (+ i 1)]) ((= i n) (utf8->string bv))
        (bytevector-u8-set! bv i (lib st "%h-string-byte" h i)))))

  ;; A handle -> a Chez datum.
  (define (decode st h)
    (case (lib st "%h-kind" h)
      [(0) #f]
      [(1) (lib st "%h-fixnum-value" h)]
      [(2) #t]
      [(3) '()]
      [(4) (integer->char (lib st "%h-char-code" h))]
      [(5) (cons (decode st (lib st "%h-car" h)) (decode st (lib st "%h-cdr" h)))]
      [(6) (string->symbol (decode-string st (lib st "%h-symbol-name" h)))]
      [(7) (decode-string st h)]
      ;; Scope sets are sorted in Chez; a shifted literal may be out of order.
      [(8) (make-stx (decode st (lib st "%h-syntax-part" h 0))
                     (list-sort < (decode st (lib st "%h-syntax-part" h 1)))
                     (decode st (lib st "%h-syntax-part" h 2)) (decode st (lib st "%h-syntax-part" h 3)))]
      [(9) (make-srcloc (decode st (lib st "%h-srcloc-source" h))
                        (lib st "%h-srcloc-field" h 1) (lib st "%h-srcloc-field" h 2)
                        (lib st "%h-srcloc-field" h 3) (lib st "%h-srcloc-field" h 4))]
      [else (make-wasm-value h)])))
