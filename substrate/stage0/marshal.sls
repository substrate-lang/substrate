;; Copy syntax between Chez and the expander module's memory. Together with
;; stage0/expander.sub this is stage0's expander, so it is the one place
;; outside that module allowed to know the data layout (spec appendix A).
;; Building goes through the module's constructors, so its allocator and
;; intern table stay authoritative. Reading follows the layout directly.
(library (stage0 marshal)
  (export make-store store? store-host encode decode
          make-wasm-value wasm-value? wasm-value-word)
  (import (chezscheme) (stage0 syntax) (stage0 host) (stage0 compile))

  (define-record-type store (fields host symbols)
    (protocol (lambda (new) (lambda (host) (new host (make-eq-hashtable))))))

  ;; A value word with no Chez counterpart; passed back unchanged.
  (define-record-type wasm-value (fields word))

  (define (ex st name . args) (apply host-call (store-host st) "expander" name args))

  (define (encode-string st s)
    (let* ([bv (string->utf8 s)]
           [p (ex st "%alloc-string" (bytevector-length bv))])
      (host-mem-write! (store-host st) (+ p 4) bv)
      p))

  (define (encode st d)
    (let ([w (immediate-word d)])
      (cond [w w]
            [(string? d) (encode-string st d)]
            [(symbol? d)
             (or (hashtable-ref (store-symbols st) d #f)
                 (let ([w (ex st "intern" (encode-string st (symbol->string d)))])
                   (hashtable-set! (store-symbols st) d w)
                   w))]
            [(pair? d) (let* ([a (encode st (car d))] [b (encode st (cdr d))]) (ex st "cons" a b))]
            [(stx? d)
             (let* ([e (encode st (stx-e d))]
                    [scopes (encode st (stx-scopes d))]
                    [loc (encode st (stx-srcloc d))]
                    [props (encode st (stx-props d))])
               (ex st "%make-syntax" e scopes loc props))]
            [(srcloc? d)
             (let* ([source (encode st (srcloc-source d))])
               (ex st "%make-srcloc" source
                   (encode st (srcloc-line d)) (encode st (srcloc-col d))
                   (encode st (srcloc-pos d)) (encode st (srcloc-span d))))]
            [(wasm-value? d) (wasm-value-word d)]
            [else (error 'encode "cannot put this value in expander memory" d)])))

  (define (mem32 st addr) (host-mem-i32 (store-host st) addr))

  (define (heap-type st w)
    (and (not (zero? w)) (zero? (logand w 7))
         (logand (mem32 st w) #x7F)))

  (define (heap-count st w) (logand (ash (mem32 st w) -8) #xFFFFFF))

  (define (field st w i) (mem32 st (+ w 4 (* 4 i))))

  (define (read-bytes st addr n)
    (let ([bv (make-bytevector n)] [h (store-host st)])
      (do ([i 0 (+ i 1)]) ((= i n) bv)
        (bytevector-u8-set! bv i (host-mem-u8 h (+ addr i))))))

  (define (decode st w)
    (cond [(odd? w) (ash w -1)]
          [(zero? w) #f]
          [(= w 10) #t]
          [(= w 18) '()]
          [(= (logand w 7) 4) (integer->char (ash w -3))]
          [(= (logand w 7) 0)
           (case (heap-type st w)
             [(1) (cons (decode st (field st w 0)) (decode st (field st w 1)))]
             [(2) (string->symbol (decode st (field st w 0)))]
             [(3) (utf8->string (read-bytes st (+ w 4) (heap-count st w)))]
             [(4) (make-stx (decode st (field st w 0)) (decode st (field st w 1))
                            (decode st (field st w 2)) (decode st (field st w 3)))]
             [(5) (make-srcloc (decode st (field st w 0)) (decode st (field st w 1))
                               (decode st (field st w 2)) (decode st (field st w 3))
                               (decode st (field st w 4)))]
             [else (make-wasm-value w)])]
          [else (make-wasm-value w)])))
