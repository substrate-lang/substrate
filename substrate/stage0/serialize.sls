;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; The byte format of syntax-library data (compiler/syntax.sub, "quoted
;; data"). The compiler writes a part's quoted data in it (spec 3.5), and
;; stage0 copies syntax between Chez and the wasm heap in it (marshal.sls).
(library (stage0 serialize)
  (export fixnum-min fixnum-max make-serializer serialize! serializer-bytes deserialize)
  (import (chezscheme) (stage0 syntax) (stage0 wasm))

  ;; The fixnum range: an i31ref holds a signed 31-bit integer.
  (define fixnum-min (- (expt 2 30)))
  (define fixnum-max (- (expt 2 30) 1))

  (define (fixnum-range? d) (and (integer? d) (exact? d) (<= fixnum-min d fixnum-max)))

  ;; Objects are written as they are met, each after the objects it is made
  ;; of. Equal immutable objects are written once and shared, as Scheme
  ;; allows of literals; strings, which are mutable, never are. other: a
  ;; procedure giving the handle of a value the format has no kind for
  ;; (written as kind 12), or failing.
  (define-record-type (serializer new-serializer serializer?) (fields port get (mutable count) shared other))

  (define (make-serializer other)
    (let-values ([(port get) (open-bytevector-output-port)])
      (new-serializer port get 0 (make-hashtable equal-hash equal?) other)))

  ;; The index of datum d, writing it if need be.
  (define (serialize! s d)
    (define p (serializer-port s))
    ;; Write an object with write!, unless one with the same key was; a key
    ;; of #f is never shared.
    (define (object! key write!)
      (or (and key (hashtable-ref (serializer-shared s) key #f))
          (let ([i (serializer-count s)])
            (write!)
            (serializer-count-set! s (+ i 1))
            (when key (hashtable-set! (serializer-shared s) key i))
            i)))
    (define (utf8! str)
      (let ([bv (string->utf8 str)])
        (uleb! p (bytevector-length bv))
        (put-bytevector p bv)))
    (define (u64! n)
      (let ([bv (make-bytevector 8)])
        (bytevector-u64-set! bv 0 n (endianness little))
        (put-bytevector p bv)))
    (let loop ([d d])
      (cond
        [(eq? d #f) (object! '(0) (lambda () (put-u8 p 0)))]
        [(fixnum-range? d) (object! (list 1 d) (lambda () (put-u8 p 1) (sleb! p d)))]
        [(and (integer? d) (exact? d) (<= (- (expt 2 63)) d (- (expt 2 64) 1)))
         ;; Beyond the fixnum range: a sign and a 64-bit magnitude.
         (object! (list 10 d) (lambda () (put-u8 p 10) (put-u8 p (if (< d 0) 1 0)) (u64! (abs d))))]
        [(flonum? d)
         (object! (list 11 d) (lambda ()
                                (let ([bv (make-bytevector 8)])
                                  (put-u8 p 11)
                                  (bytevector-ieee-double-set! bv 0 d (endianness little))
                                  (put-bytevector p bv))))]
        [(eq? d #t) (object! '(2) (lambda () (put-u8 p 2)))]
        [(null? d) (object! '(3) (lambda () (put-u8 p 3)))]
        [(char? d) (object! (list 4 d) (lambda () (put-u8 p 4) (uleb! p (char->integer d))))]
        [(pair? d)
         (let* ([a (loop (car d))] [b (loop (cdr d))])
           (object! (list 5 a b) (lambda () (put-u8 p 5) (uleb! p a) (uleb! p b))))]
        [(symbol? d) (object! (list 6 d) (lambda () (put-u8 p 6) (utf8! (symbol->string d))))]
        [(string? d) (object! #f (lambda () (put-u8 p 7) (utf8! d)))]
        [(stx? d)
         (let* ([e (loop (stx-e d))] [sc (loop (stx-scopes d))]
                [l (loop (stx-srcloc d))] [r (loop (stx-props d))])
           (object! (list 8 e sc l r) (lambda () (put-u8 p 8) (for-each (lambda (i) (uleb! p i)) (list e sc l r)))))]
        [(srcloc? d)
         (let ([src (loop (srcloc-source d))]
               [fields (list (srcloc-line d) (srcloc-col d) (srcloc-pos d) (srcloc-span d))])
           (object! (cons* 9 src fields)
                    (lambda () (put-u8 p 9) (uleb! p src) (for-each (lambda (n) (sleb! p n)) fields))))]
        [else
         (let ([h ((serializer-other s) d)])
           (object! (list 12 h) (lambda () (put-u8 p 12) (uleb! p h))))])))

  ;; The bytes: the number of objects, then the objects.
  (define (serializer-bytes s)
    (let-values ([(port get) (open-bytevector-output-port)])
      (uleb! port (serializer-count s))
      (put-bytevector port ((serializer-get s)))
      (get)))

  ;; The last object bv describes. other: a procedure making the Chez value
  ;; for a handle (kind 12). Scope sets are sorted in Chez; a shifted literal
  ;; may be out of order.
  (define (deserialize bv other)
    (define at 0)
    (define (byte!) (let ([b (bytevector-u8-ref bv at)]) (set! at (+ at 1)) b))
    (define (uleb)
      (let loop ([n 0] [shift 0])
        (let ([b (byte!)])
          (let ([n (logor n (ash (logand b 127) shift))])
            (if (zero? (logand b 128)) n (loop n (+ shift 7)))))))
    (define (sleb)
      (let loop ([n 0] [shift 0])
        (let* ([b (byte!)] [n (logor n (ash (logand b 127) shift))] [shift (+ shift 7)])
          (cond [(not (zero? (logand b 128))) (loop n shift)]
                [(zero? (logand b 64)) n]
                [else (- n (ash 1 shift))]))))
    (define (u64)
      (let ([n (bytevector-u64-ref bv at (endianness little))]) (set! at (+ at 8)) n))
    (define (utf8)
      (let* ([n (uleb)] [s (utf8->string (subbytevector bv at (+ at n)))]) (set! at (+ at n)) s))
    (define (subbytevector bv start end)
      (let ([r (make-bytevector (- end start))]) (bytevector-copy! bv start r 0 (- end start)) r))
    (let* ([n (uleb)] [objs (make-vector n #f)])
      (define (obj) (vector-ref objs (uleb)))
      (do ([i 0 (+ i 1)]) ((= i n))
        (vector-set!
         objs i
         (case (byte!)
           [(0) #f]
           [(1) (sleb)]
           [(2) #t]
           [(3) '()]
           [(4) (integer->char (uleb))]
           [(5) (let* ([a (obj)] [d (obj)]) (cons a d))]
           [(6) (string->symbol (utf8))]
           [(7) (utf8)]
           [(8) (let* ([e (obj)] [sc (obj)] [l (obj)] [r (obj)]) (make-stx e (list-sort < sc) l r))]
           [(9) (let* ([src (obj)] [line (sleb)] [col (sleb)] [pos (sleb)] [span (sleb)])
                  (make-srcloc src line col pos span))]
           [(10) (let* ([negative (byte!)] [m (u64)]) (if (= negative 1) (- m) m))]
           [(11) (let ([bits (u64)] [b (make-bytevector 8)])
                   (bytevector-u64-set! b 0 bits (endianness little))
                   (bytevector-ieee-double-ref b 0 (endianness little)))]
           [(12) (other (uleb))]
           [else (error 'deserialize "unknown kind")])))
      (vector-ref objs (- n 1)))))
