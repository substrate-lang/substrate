;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Syntax objects and source locations, mirroring spec section 2.4 field for
;; field so that marshalling to the wasm heap is a direct copy.
(library (stage0 syntax)
  (export make-stx stx? stx-e stx-scopes stx-srcloc stx-props
          make-srcloc srcloc? srcloc-source srcloc-line srcloc-col srcloc-pos srcloc-span
          id? stx->datum datum->stx stx->list stx-rewrap
          keyword? keyword-name string->keyword
          scopes-add scopes-remove scopes-flip scopes-subset? add-scope flip-scope remove-scopes
          filter-scopes
          compile-error? compile-error-message compile-error-srcloc
          format-srcloc raise-compile-error map-lr)
  (import (chezscheme))

  ;; map, applying f left to right. Chez's map leaves the order open, and
  ;; expansion and compilation have effects (fresh keys, locals, macro calls).
  (define (map-lr f l . ls)
    (if (null? ls)
        (let loop ([l l] [acc (quote ())])
          (if (null? l) (reverse acc) (loop (cdr l) (cons (f (car l)) acc))))
        (let loop ([lists (cons l ls)] [acc (quote ())])
          (if (null? (car lists))
              (reverse acc)
              (loop (map cdr lists) (cons (apply f (map car lists)) acc))))))

  (define-record-type stx (fields e scopes srcloc props))
  (define-record-type srcloc (fields source line col pos span))

  (define (id? x) (and (stx? x) (symbol? (stx-e x))))

  ;; Keywords: #:name reads as one, interned by name, so equal keywords are
  ;; eq?. They print as they read.
  (define-record-type (keyword new-keyword keyword?) (fields name))   ; name: a string
  (define keywords (make-hashtable string-hash string=?))
  (define (string->keyword s)
    (or (hashtable-ref keywords s #f)
        (let ([k (new-keyword (string->immutable-string s))])
          (hashtable-set! keywords s k)
          k)))
  (define keyword-printing
    (record-writer (record-type-descriptor keyword)
                   (lambda (k port wr) (display "#:" port) (display (keyword-name k) port))))

  ;; ---- scope sets: sorted lists of fixnums --------------------------------

  (define (scopes-add set sc)
    (cond [(null? set) (list sc)]
          [(= (car set) sc) set]
          [(< sc (car set)) (cons sc set)]
          [else (cons (car set) (scopes-add (cdr set) sc))]))

  (define (scopes-remove set sc)
    (cond [(null? set) set]
          [(= (car set) sc) (cdr set)]
          [else (cons (car set) (scopes-remove (cdr set) sc))]))

  (define (scopes-flip set sc)
    (if (memv sc set) (scopes-remove set sc) (scopes-add set sc)))

  (define (scopes-subset? a b)
    (cond [(null? a) #t]
          [(null? b) #f]
          [(= (car a) (car b)) (scopes-subset? (cdr a) (cdr b))]
          [(> (car a) (car b)) (scopes-subset? a (cdr b))]
          [else #f]))

  ;; Apply op to the scopes of every syntax object inside x.
  (define (map-scopes x op)
    (cond [(stx? x)
           (make-stx (map-scopes (stx-e x) op) (op (stx-scopes x)) (stx-srcloc x) (stx-props x))]
          [(pair? x) (cons (map-scopes (car x) op) (map-scopes (cdr x) op))]
          [(vector? x) (vector-map (lambda (y) (map-scopes y op)) x)]
          [else x]))

  (define (add-scope x sc) (map-scopes x (lambda (s) (scopes-add s sc))))
  (define (remove-scopes x scs) (map-scopes x (lambda (s) (fold-left scopes-remove s scs))))
  (define (flip-scope x sc) (map-scopes x (lambda (s) (scopes-flip s sc))))
  (define (filter-scopes x keep?) (map-scopes x (lambda (s) (filter keep? s))))

  ;; ---- conversions --------------------------------------------------------

  (define (stx->datum x)
    (cond [(stx? x) (stx->datum (stx-e x))]
          [(pair? x) (cons (stx->datum (car x)) (stx->datum (cdr x)))]
          [(vector? x) (vector-map stx->datum x)]
          [else x]))

  ;; Wrap a datum with the scopes of ctx (a syntax object or #f).
  (define (datum->stx ctx d srcloc)
    (let ([scopes (if ctx (stx-scopes ctx) '())])
      (let wrap ([d d])
        (cond [(stx? d) d]
              [(pair? d) (make-stx (let wrap-list ([d d])
                                     (cond [(pair? d) (cons (wrap (car d)) (wrap-list (cdr d)))]
                                           [(null? d) '()]
                                           [else (wrap d)]))
                                   scopes srcloc '())]
              [(vector? d) (make-stx (vector-map wrap d) scopes srcloc '())]
              [else (make-stx d scopes srcloc '())]))))

  ;; The elements of a syntax list, or #f if x is not a proper syntax list.
  (define (stx->list x)
    (let ([e (if (stx? x) (stx-e x) x)])
      (and (list? e) e)))

  (define (stx-rewrap x e) (make-stx e (stx-scopes x) (stx-srcloc x) (stx-props x)))

  ;; ---- errors -------------------------------------------------------------

  (define-condition-type &compile-error &error make-compile-error compile-error?
    (text compile-error-message)
    (where compile-error-srcloc))

  (define (format-srcloc loc)
    (if (srcloc? loc)
        (format "~a:~a:~a" (srcloc-source loc) (srcloc-line loc) (+ 1 (srcloc-col loc)))
        "<unknown>"))

  ;; (raise-compile-error stx-or-#f fmt arg ...)
  (define (raise-compile-error where fmt . args)
    (let ([loc (cond [(stx? where) (stx-srcloc where)]
                     [(srcloc? where) where]
                     [else #f])])
      (raise (condition (make-compile-error (apply format fmt args) loc))))))

