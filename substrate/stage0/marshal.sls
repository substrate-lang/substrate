;; Copy data between Chez and a store's heap, following spec section 2.
;; Building goes through rt's constructors, so rt's allocator and intern
;; table stay authoritative. Reading follows the layout directly.
(library (stage0 marshal)
  (export make-store store? store-host encode decode proc-index
          make-wasm-value wasm-value? wasm-value-word heap-type)
  (import (chezscheme) (stage0 syntax) (stage0 host) (stage0 compile))

  (define-record-type store (fields host symbols)
    (protocol (lambda (new) (lambda (host) (new host (make-eq-hashtable))))))

  ;; A value word from the heap that has no Chez counterpart.
  (define-record-type wasm-value (fields word))

  (define (rt st name . args) (apply host-call (store-host st) "rt" name args))

  (define (encode-string st s)
    (let* ([bv (string->utf8 s)]
           [p (rt st "alloc-string" (bytevector-length bv))])
      (host-mem-write! (store-host st) (+ p 4) bv)
      p))

  (define (encode st d)
    (let ([w (immediate-word d)])
      (cond [w w]
            [(string? d) (encode-string st d)]
            [(symbol? d)
             (or (hashtable-ref (store-symbols st) d #f)
                 (let ([w (rt st "intern" (encode-string st (symbol->string d)))])
                   (hashtable-set! (store-symbols st) d w)
                   w))]
            [(pair? d) (let* ([a (encode st (car d))] [b (encode st (cdr d))]) (rt st "cons" a b))]
            [(vector? d) (rt st "list->vector" (encode st (vector->list d)))]
            [(stx? d)
             (let* ([e (encode st (stx-e d))]
                    [scopes (encode st (stx-scopes d))]
                    [loc (encode st (stx-srcloc d))]
                    [props (encode st (stx-props d))])
               (rt st "make-syntax" e scopes loc props))]
            [(srcloc? d)
             (let* ([source (encode st (srcloc-source d))])
               (rt st "make-srcloc" source
                   (encode st (srcloc-line d)) (encode st (srcloc-col d))
                   (encode st (srcloc-pos d)) (encode st (srcloc-span d))))]
            [(wasm-value? d) (wasm-value-word d)]
            [else (error 'encode "cannot put this value in the heap" d)])))

  (define (mem32 st addr) (host-mem-i32 (store-host st) addr))

  ;; The type code of the heap object w points to, or #f.
  (define (heap-type st w)
    (and (not (zero? w)) (zero? (logand w 7))
         (logand (mem32 st w) #x7F)))

  (define (heap-length st w) (logand (ash (mem32 st w) -8) #xFFFFFF))

  (define (field st w i) (mem32 st (+ w 4 (* 4 i))))

  (define (read-bytes st addr n)
    (let ([bv (make-bytevector n)] [h (store-host st)])
      (do ([i 0 (+ i 1)]) ((= i n) bv)
        (bytevector-u8-set! bv i (host-mem-u8 h (+ addr i))))))

  (define (decode st w)
    (cond [(odd? w) (ash w -1)]
          [(zero? w) #f]
          [(= (logand w 7) 2)
           (case (ash w -3)
             [(1) #t] [(2) '()] [(3) (void)] [(4) (eof-object)]
             [else (make-wasm-value w)])]
          [(= (logand w 7) 4) (integer->char (ash w -3))]
          [(= (logand w 7) 0)
           (case (heap-type st w)
             [(1) (cons (decode st (field st w 0)) (decode st (field st w 1)))]
             [(2) (string->symbol (decode st (field st w 0)))]
             [(3) (utf8->string (read-bytes st (+ w 4) (heap-length st w)))]
             [(4) (let ([n (heap-length st w)])
                    (let ([v (make-vector n)])
                      (do ([i 0 (+ i 1)]) ((= i n) v)
                        (vector-set! v i (decode st (field st w i))))))]
             [(6) (make-stx (decode st (field st w 0)) (decode st (field st w 1))
                            (decode st (field st w 2)) (decode st (field st w 3)))]
             [(9) (make-srcloc (decode st (field st w 0)) (decode st (field st w 1))
                               (decode st (field st w 2)) (decode st (field st w 3))
                               (decode st (field st w 4)))]
             [else (make-wasm-value w)])]
          [else (make-wasm-value w)]))

  ;; The table index of a procedure value, or #f if w is not a procedure.
  (define (proc-index st w)
    (and (eqv? (heap-type st w) 7)
         (ash (field st w 0) -1))))
