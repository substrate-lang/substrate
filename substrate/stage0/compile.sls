;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Compiler: fully expanded kernel forms (see core.sls) -> wasm module bytes.
;;
;; Expressions are compiled to symbolic instructions that mention info
;; records instead of indices; a final pass assigns indices once every
;; import, type and synthesized global is known.
;;
;; A module imports only what its code uses (spec 3.3). Code that needs a
;; memory or table must be given one: defined, or imported from a module.
(library (stage0 compile)
  (export compile-module current-syntax-infos fixnum-min fixnum-max set-string-type!)
  (import (chezscheme) (stage0 syntax) (stage0 core) (stage0 ops) (stage0 wasm))

  ;; symbol -> func-info for the syntax library's exports; #f while
  ;; compiling the syntax library itself.
  (define current-syntax-infos (make-parameter #f))

  (define fixnum-min (- (expt 2 30)))
  (define fixnum-max (- (expt 2 30) 1))

  ;; The syntax library's string type, set once the library is compiled.
  ;; Quoted strings are built with array.new_fixed of it, so a module that
  ;; quotes one declares the library's recursion group, and wasm makes it
  ;; the library's type (spec appendix A).
  (define string-type #f)
  (define (set-string-type! t) (set! string-type t))

  (define eqref (make-ref #t 'eq))

  ;; ---- error locations ------------------------------------------------------

  (define current-loc (make-parameter #f))
  (define (fail fmt . args) (apply raise-compile-error (current-loc) fmt args))

  ;; ---- types ------------------------------------------------------------------

  (define (type->string t)
    (cond [(eq? t 'bottom) "nothing (unreachable)"]
          [(null? t) "no value"]
          [(null? (cdr t)) (valtype->string (car t))]
          [else (format "(~a)" (apply string-append
                                      (let loop ([ts t])
                                        (if (null? ts) '()
                                            (cons (valtype->string (car ts))
                                                  (if (null? (cdr ts)) '() (cons " " (loop (cdr ts)))))))))]))

  (define (single? t) (and (pair? t) (null? (cdr t))))

  ;; Make code of type `type` fit `expected`: drop unused values, or fail.
  ;; A subtype fits without any code.
  (define (coerce code type expected)
    (cond [(not expected) (values code type)]
          [(eq? type 'bottom) (values code expected)]
          [(types<=? type expected) (values code expected)]
          [(null? expected) (values (append code (map-lr (lambda (_) '(drop)) type)) '())]
          [else
           (let ([e (type->string expected)] [g (type->string type)])
             ;; Two declarations can have the same name, for example one
             ;; in each module (spec 5.1).
             (fail "type mismatch: expected ~a, got ~a~a" e g
                   (if (string=? e g) ", a different type declared with the same name" "")))]))

  (define (join-types a b)
    (cond [(eq? a 'bottom) b]
          [(eq? b 'bottom) a]
          [(and (= (length a) (length b)))
           (let ([j (map valtype-join a b)])
             (and (for-all values j) j))]
          [else #f]))

  (define (s32 n)
    (unless (<= (- (expt 2 31)) n (- (expt 2 32) 1))
      (fail "integer ~a does not fit in i32" n))
    (if (>= n (expt 2 31)) (- n (expt 2 32)) n))

  (define (s64 n)
    (unless (<= (- (expt 2 63)) n (- (expt 2 64) 1))
      (fail "integer ~a does not fit in i64" n))
    (if (>= n (expt 2 63)) (- n (expt 2 64)) n))

  ;; ---- per-function state -----------------------------------------------------

  (define-record-type fctx
    (fields locals               ; eqv hashtable: key -> (index . type)
            (mutable extra)      ; types of locals after the params, reversed
            (mutable next)       ; next local index
            results))            ; the function's result types

  (define (new-fctx params results)
    (let ([fc (make-fctx (make-eqv-hashtable) '() 0 results)])
      (for-each (lambda (p) (add-local! fc (car p) (cdr p))) params)
      (fctx-extra-set! fc '())
      fc))

  (define (add-local! fc key type)
    (let ([i (fctx-next fc)])
      (hashtable-set! (fctx-locals fc) key (cons i type))
      (fctx-extra-set! fc (cons type (fctx-extra fc)))
      (fctx-next-set! fc (+ i 1))
      i))

  (define (temp-local! fc type) (add-local! fc (list 'temp) type))

  (define (lookup-local fc key)
    (or (hashtable-ref (fctx-locals fc) key #f)
        (fail "internal: unknown local ~a" key)))

  ;; kind: block | loop | if. type: the block's result type once known.
  (define-record-type label (fields key kind (mutable type)))

  (define (label-depth labels key)
    (let loop ([ls labels] [d 0])
      (cond [(null? ls) (fail "internal: unknown label ~a" key)]
            [(eqv? (label-key (car ls)) key) (values d (car ls))]
            [else (loop (cdr ls) (+ d 1))])))

  ;; ---- module state -------------------------------------------------------------

  ;; A synthesized global: a quoted constant or a function's table index.
  (define-record-type synth (fields kind datum))

  (define-record-type mstate
    (fields self
            (mutable func-imports)   ; external func-infos, reversed
            (mutable global-imports) ; external global-infos, reversed
            (mutable synths)         ; synth records, reversed
            (mutable fidx)           ; alist func-info -> synth
            (mutable uses-memory)    ; where code first needs a memory, or #f
            (mutable uses-table)     ; where code first needs a table, or #f
            (mutable uses-gc)))      ; does code allocate or inspect GC objects?

  (define (external? ms info-instance) (not (equal? info-instance (mstate-self ms))))

  (define (note-func! ms info)
    (when (and (external? ms (func-info-instance info))
               (not (memq info (mstate-func-imports ms))))
      (mstate-func-imports-set! ms (cons info (mstate-func-imports ms)))))

  (define (note-global! ms info)
    (when (and (global-info? info)
               (external? ms (global-info-instance info))
               (not (memq info (mstate-global-imports ms))))
      (mstate-global-imports-set! ms (cons info (mstate-global-imports ms)))))

  (define (note-memory! ms) (unless (mstate-uses-memory ms) (mstate-uses-memory-set! ms (or (current-loc) #t))))
  (define (note-table! ms) (unless (mstate-uses-table ms) (mstate-uses-table-set! ms (or (current-loc) #t))))

  (define (new-synth! ms kind datum)
    (let ([s (make-synth kind datum)])
      (mstate-synths-set! ms (cons s (mstate-synths ms)))
      s))

  (define (fidx-synth! ms info)
    (note-table! ms)
    (cond [(assq info (mstate-fidx ms)) => cdr]
          [else (let ([s (new-synth! ms 'fidx info)])
                  (note-func! ms info)
                  (mstate-fidx-set! ms (cons (cons info s) (mstate-fidx ms)))
                  s)]))

  ;; ---- expressions ------------------------------------------------------------

  ;; A function of the syntax library, by name. While compiling the
  ;; syntax library itself, its own functions are found with `local`.
  (define (syntax-func ms local name)
    (let ([info (if (current-syntax-infos)
                    (hashtable-ref (current-syntax-infos) name #f)
                    (local name))])
      (unless info (fail "internal: the syntax library has no function ~a" name))
      (note-func! ms info)
      info))

  (define (struct-field tinfo index) (list-ref (type-info-fields tinfo) index))

  ;; Compile e. expected: #f or a list of valtypes. tail?: e's value is the
  ;; function's return value. Returns (values code type).
  (define (cx ms fc labels e expected tail?)
    (define (sub e expected tail?) (cx ms fc labels e expected tail?))
    (define (sub-in labels e expected tail?) (cx ms fc labels e expected tail?))
    (define (code-of e type) (let-values ([(c _) (sub e (list type) #f)]) c))
    (define (args-code args types)
      (unless (= (length args) (length types))
        (fail "expected ~a arguments, got ~a" (length types) (length args)))
      (apply append (map-lr code-of args types)))
    ;; Synthesize the type of a reference expression.
    (define (ref-arg e who)
      (let-values ([(c t) (sub e #f #f)])
        (unless (and (single? t) (ref-type? (car t)))
          (fail "~a needs a reference, got ~a" who (type->string t)))
        (values c (car t))))
    (define (blocktype t)
      (cond [(null? t) '()]
            [(single? t) (car t)]
            [else (list 'type (list 'func '() t))]))
    (define (finish code type) (coerce code type expected))
    ;; GC operations (spec 5.3). imms hold type-infos, field indices and
    ;; reference types resolved by the expander.
    (define (compile-gc op imms args)
      (define (arg i type) (code-of (list-ref args i) type))
      (define (tref t) (make-ref #t t))
      (case op
        [(struct.new)
         (let ([t (car imms)])
           (finish (append (args-code args (map (lambda (f) (unpacked (cadr f))) (type-info-fields t)))
                           `((struct.new ,t)))
                   (list (make-ref #f t))))]
        [(struct.get struct.get_s struct.get_u)
         (let* ([t (car imms)] [i (cadr imms)] [f (struct-field t i)] [packed? (memq (cadr f) '(i8 i16))])
           (when (and packed? (eq? op 'struct.get))
             (fail "field ~a is packed: use struct.get_s or struct.get_u" (car f)))
           (when (and (not packed?) (not (eq? op 'struct.get)))
             (fail "~a is only for packed fields" op))
           (finish (append (arg 0 (tref t)) `((,op ,t ,i))) (list (unpacked (cadr f)))))]
        [(struct.set)
         (let* ([t (car imms)] [i (cadr imms)] [f (struct-field t i)])
           (unless (caddr f) (fail "field ~a is not mutable" (car f)))
           (finish (append (arg 0 (tref t)) (arg 1 (unpacked (cadr f))) `((struct.set ,t ,i))) '()))]
        [(array.new)
         (let ([t (car imms)])
           (finish (append (arg 0 (unpacked (car (type-info-fields t)))) (arg 1 'i32) `((array.new ,t)))
                   (list (make-ref #f t))))]
        [(array.new_default)
         (let ([t (car imms)])
           (finish (append (arg 0 'i32) `((array.new_default ,t))) (list (make-ref #f t))))]
        [(array.new_fixed)
         (let ([t (car imms)])
           (finish (append (apply append (map-lr (lambda (a) (code-of a (unpacked (car (type-info-fields t))))) args))
                           `((array.new_fixed ,t ,(length args))))
                   (list (make-ref #f t))))]
        [(array.get array.get_s array.get_u)
         (let* ([t (car imms)] [storage (car (type-info-fields t))] [packed? (memq storage '(i8 i16))])
           (when (and packed? (eq? op 'array.get))
             (fail "~a has packed elements: use array.get_s or array.get_u" (type-info-name t)))
           (when (and (not packed?) (not (eq? op 'array.get)))
             (fail "~a is only for packed elements" op))
           (finish (append (arg 0 (tref t)) (arg 1 'i32) `((,op ,t))) (list (unpacked storage))))]
        [(array.set)
         (let ([t (car imms)])
           (unless (cadr (type-info-fields t)) (fail "~a is not mutable" (type-info-name t)))
           (finish (append (arg 0 (tref t)) (arg 1 'i32) (arg 2 (unpacked (car (type-info-fields t))))
                           `((array.set ,t)))
                   '()))]
        [(array.len)
         (finish (append (arg 0 (make-ref #t 'array)) '((array.len))) '(i32))]
        [(array.fill)
         (let ([t (car imms)])
           (finish (append (arg 0 (tref t)) (arg 1 'i32) (arg 2 (unpacked (car (type-info-fields t)))) (arg 3 'i32)
                           `((array.fill ,t)))
                   '()))]
        [(array.copy)
         (let ([dst (car imms)] [src (cadr imms)])
           (finish (append (arg 0 (tref dst)) (arg 1 'i32) (arg 2 (tref src)) (arg 3 'i32) (arg 4 'i32)
                           `((array.copy ,dst ,src)))
                   '()))]
        [(ref.null)
         (finish `((ref.null ,(car imms))) (list (make-ref #t (car imms))))]
        [(ref.is_null)
         (let-values ([(c t) (ref-arg (car args) "ref.is_null")])
           (finish (append c '((ref.is_null))) '(i32)))]
        [(ref.eq)
         (finish (append (arg 0 eqref) (arg 1 eqref) '((ref.eq))) '(i32))]
        [(ref.as_non_null)
         (let-values ([(c t) (ref-arg (car args) "ref.as_non_null")])
           (finish (append c '((ref.as_non_null))) (list (make-ref #f (ref-heap t)))))]
        [(ref.test ref.cast)
         (let ([target (car imms)])
           (let-values ([(c t) (ref-arg (car args) (symbol->string op))])
             (finish (append c `((,op ,(ref-nullable? target) ,(ref-heap target))))
                     (if (eq? op 'ref.test) '(i32) (list target)))))]
        [(ref.i31)
         (finish (append (arg 0 'i32) '((ref.i31))) (list (make-ref #f 'i31)))]
        [(i31.get_s i31.get_u)
         (finish (append (arg 0 (make-ref #t 'i31)) `((,op))) '(i32))]
        [else (fail "internal: unknown GC operation ~a" op)]))
    (record-case e
      [(at) (loc inner)
       (parameterize ([current-loc (or loc (current-loc))]) (sub inner expected tail?))]
      [(int) (n)
       (let ([t (if (single? expected) (car expected) 'i32)])
         (case t
           [(i64) (finish `((i64.const ,(s64 n))) '(i64))]
           [(f32) (finish `((f32.const ,(inexact n))) '(f32))]
           [(f64) (finish `((f64.const ,(inexact n))) '(f64))]
           [else (finish `((i32.const ,(s32 n))) '(i32))]))]
      [(float) (x)
       (if (equal? expected '(f32))
           (finish `((f32.const ,x)) '(f32))
           (finish `((f64.const ,x)) '(f64)))]
      [(const) (t n)
       (finish (case t
                 [(i32) `((i32.const ,(s32 n)))]
                 [(i64) `((i64.const ,(s64 n)))]
                 [else `((,(const-op t) ,n))])
               (list t))]
      [(lref) (key)
       (let ([l (lookup-local fc key)])
         (finish `((local.get ,(car l))) (list (cdr l))))]
      [(lset) (key v)
       (let ([l (lookup-local fc key)])
         (finish (append (code-of v (cdr l)) `((local.set ,(car l)))) '()))]
      [(gref) (info)
       (note-global! ms info)
       (finish `((global.get ,info)) (list (global-info-type info)))]
      [(gset) (info v)
       (unless (global-info-mutable? info)
         (fail "~a is immutable: declare it (global ~a (mut type) init) to set it"
               (global-info-name info) (global-info-name info)))
       (note-global! ms info)
       (finish (append (code-of v (global-info-type info)) `((global.set ,info))) '())]
      [(let) (bindings body)
       (let ([init-code
              (apply append
                     (map-lr (lambda (b)
                               (let ([key (car b)] [declared (cadr b)] [init (caddr b)])
                                 (let-values ([(c t) (sub init (and declared (list declared)) #f)])
                                   (unless (single? t)
                                     (fail "a let binding needs a single value, got ~a~a" (type->string t)
                                           (if (eq? t 'bottom) "; give it a type" "")))
                                   (let ([i (add-local! fc key (car t))])
                                     (append c `((local.set ,i)))))))
                             bindings))])
         (let-values ([(c t) (sub body expected tail?)])
           (values (append init-code c) t)))]
      [(seq) es
       (if (null? es)
           (finish '() '())
           (let loop ([es es] [acc '()])
             (if (null? (cdr es))
                 (let-values ([(c t) (sub (car es) expected tail?)])
                   (values (apply append (reverse (cons c acc))) t))
                 (let-values ([(c _) (sub (car es) '() #f)])
                   (loop (cdr es) (cons c acc))))))]
      [(if) (test then els)
       (let-values ([(tc _) (sub test '(i32) #f)])
         (let ([lbls (cons (make-label #f 'if #f) labels)])
           (if (not els)
               (let-values ([(c _) (sub-in lbls then '() #f)])
                 (finish (append tc `((if () ,c ()))) '()))
               (let*-values ([(c1 t1) (sub-in lbls then expected tail?)]
                             ;; Without an expected type, numeric literals in
                             ;; the else branch take the then branch's type.
                             [(c2 t2) (sub-in lbls els
                                              (or expected
                                                  (and (not (eq? t1 'bottom)) (for-all numeric-type? t1) t1))
                                              tail?)])
                 (let ([t (or expected
                              (join-types t1 t2)
                              (fail "the branches of if have different types: ~a and ~a"
                                    (type->string t1) (type->string t2)))])
                   (let ([t (if (eq? t 'bottom) '() t)])
                     (values (append tc `((if ,(blocktype t) ,c1 ,c2))) t)))))))]
      [(block) (key body)
       (let* ([lbl (make-label key 'block expected)])
         (let-values ([(c t) (sub-in (cons lbl labels) body expected tail?)])
           (let ([t (cond [(not (eq? t 'bottom))
                           (when (and (label-type lbl) (not (types<=? t (label-type lbl))))
                             (fail "block result is ~a but a br carries ~a"
                                   (type->string t) (type->string (label-type lbl))))
                           (or (label-type lbl) t)]
                          [(label-type lbl) (label-type lbl)]
                          [else '()])])
             (values `((block ,(blocktype t) ,c)) t))))]
      [(loop) (key body)
       (let ([lbl (make-label key 'loop '())])
         (let-values ([(c t) (sub-in (cons lbl labels) body expected tail?)])
           (let ([t (if (eq? t 'bottom) (or expected '()) t)])
             (values `((loop ,(blocktype t) ,c)) t))))]
      [(br) (key v)
       (let-values ([(depth lbl) (label-depth labels key)])
         (if (eq? (label-kind lbl) 'loop)
             (begin
               (when v (fail "br to a loop label cannot carry a value"))
               (values `((br ,depth)) 'bottom))
             (let-values ([(c t) (if v (sub v (label-type lbl) #f) (values '() '()))])
               (cond [(not (label-type lbl)) (label-type-set! lbl t)]
                     [(not (types<=? t (label-type lbl)))
                      (fail "br carries ~a but the block produces ~a"
                            (type->string t) (type->string (label-type lbl)))])
               (values (append c `((br ,depth))) 'bottom))))]
      [(br-if) (key test)
       (let-values ([(depth lbl) (label-depth labels key)]
                    [(tc _) (sub test '(i32) #f)])
         (unless (eq? (label-kind lbl) 'loop)
           (cond [(not (label-type lbl)) (label-type-set! lbl '())]
                 [(not (null? (label-type lbl)))
                  (fail "br-if cannot exit a block that produces ~a" (type->string (label-type lbl)))]))
         (finish (append tc `((br_if ,depth))) '()))]
      [(return) (v)
       (let-values ([(c _) (if v (sub v (fctx-results fc) #t) (values '() '()))])
         (unless (or v (null? (fctx-results fc)))
           (fail "return needs a value of type ~a" (type->string (fctx-results fc))))
         (values (append c '((return))) 'bottom))]
      [(call) (info args)
       (note-func! ms info)
       (let ([code (args-code args (func-info-params info))]
             [results (func-info-results info)])
         (if (and tail? (types<=? results (fctx-results fc)))
             (values (append code `((return_call ,info))) results)
             (finish (append code `((call ,info))) results)))]
      [(prim) (name offset args)
       (let ([p (lookup-prim name)])
         (when (or (eq? (prim-op-kind p) 'mem) (memq name '(memory.size memory.grow memory.copy memory.fill)))
           (note-memory! ms))
         (let ([code (args-code args (prim-op-params p))])
           (finish (append code
                           (if (eq? (prim-op-kind p) 'mem)
                               `((,name ,(prim-op-align p) ,(or offset 0)))
                               `((,name))))
                   (prim-op-results p))))]
      [(call-indirect) (params results idx args)
       (note-table! ms)
       (let* ([code (args-code args params)]
              [ic (code-of idx 'i32)]
              [sig (list 'func params results)])
         (if (and tail? (types<=? results (fctx-results fc)))
             (values (append code ic `((return_call_indirect ,sig 0))) results)
             (finish (append code ic `((call_indirect ,sig 0))) results)))]
      [(func-index) (info)
       (finish `((global.get ,(fidx-synth! ms info))) '(i32))]
      [(ref-func) (info)
       (note-func! ms info)
       (unless (func-info-type info)
         (fail "internal: ref.func of ~a, which has no declared function type" (func-info-name info)))
       (finish `((ref.func ,info)) (list (make-ref #f (func-info-type info))))]
      [(call-ref) (t f args)
       (let ([code (args-code args (car (type-info-fields t)))]
             [fcode (code-of f (make-ref #t t))]
             [results (cadr (type-info-fields t))])
         (if (and tail? (types<=? results (fctx-results fc)))
             (values (append code fcode `((return_call_ref ,t))) results)
             (finish (append code fcode `((call_ref ,t))) results)))]
      [(gc) (op imms args)
       (mstate-uses-gc-set! ms #t)
       (compile-gc op imms args)]
      [(select) (a b test)
       (let*-values ([(ca ta) (sub a #f #f)])
         (unless (single? ta) (fail "select needs single values, got ~a" (type->string ta)))
         (let-values ([(cb _b) (sub b ta #f)] [(ct _t) (sub test '(i32) #f)])
           (finish (append ca cb ct (if (ref-type? (car ta)) `((select-typed ,(car ta))) '((select)))) ta)))]
      [(drop) (v)
       (let-values ([(c t) (sub v #f #f)])
         (finish (if (eq? t 'bottom) c (append c (map-lr (lambda (_) '(drop)) t))) '()))]
      [(unreachable) () (values '((unreachable)) 'bottom)]
      [(nop) () (finish '((nop)) '())]
      [(quote) (d)
       ;; A quoted fixnum or #f is a constant; other data is built once.
       (cond [(and (integer? d) (exact? d) (<= fixnum-min d fixnum-max))
              (finish `((i32.const ,d) (ref.i31)) (list (make-ref #f 'i31)))]
             [(eq? d #f) (finish '((ref.null eq)) (list eqref))]
             [else (finish `((global.get ,(new-synth! ms 'const d))) (list eqref))])]
      [else (fail "internal: unknown kernel form ~s" (car e))]))

  ;; ---- quoted constants ---------------------------------------------------------

  ;; Code that builds datum d with the syntax library's functions and leaves
  ;; it on the stack as an eqref. tmp is unused scratch kept for symmetry.
  (define (build-datum d ex)
    (define (call name) `((call ,(ex name))))
    (define (build d) (build-datum d ex))
    (define (i32 n) `((i32.const ,n)))
    (define (string-code s)
      (let ([bv (string->utf8 s)])
        (append (apply append (map i32 (bytevector->u8-list bv)))
                `((array.new_fixed ,string-type ,(bytevector-length bv))))))
    (cond [(and (integer? d) (exact? d))
           (if (<= fixnum-min d fixnum-max)
               `((i32.const ,d) (ref.i31))
               ;; Beyond the fixnum range: a sign and a 64-bit magnitude.
               (append (i32 (if (< d 0) 1 0)) `((i64.const ,(s64 (abs d)))) (call '%make-integer)))]
          [(flonum? d) (append `((f64.const ,d)) (call 'flonum))]
          [(eq? d #f) '((ref.null eq))]
          [(eq? d #t) (call '%the-true)]
          [(null? d) (call '%the-nil)]
          [(char? d) (append (i32 (char->integer d)) (call 'integer->char))]
          [(string? d) (string-code d)]
          [(symbol? d) (append (string-code (symbol->string d)) (call 'intern))]
          [(pair? d) (append (build (car d)) (build (cdr d)) (call 'cons))]
          [(stx? d) (append (build (stx-e d)) (build (stx-scopes d))
                            (build (stx-srcloc d)) (build (stx-props d)) (call '%make-syntax))]
          [(srcloc? d) (append (build (srcloc-source d)) (i32 (srcloc-line d)) (i32 (srcloc-col d))
                               (i32 (srcloc-pos d)) (i32 (srcloc-span d)) (call '%make-srcloc))]
          [else (fail "cannot quote ~s" d)]))

  ;; ---- module -------------------------------------------------------------------

  ;; Is e a constant expression in wasm's sense (spec 5.2)? It may read
  ;; immutable globals that are imported or among `earlier`, this module's
  ;; globals defined before the one e initializes.
  (define (constant-expr? ms e earlier)
    (let loop ([e e])
      (case (car e)
        [(at) (loop (caddr e))]
        [(int float const) #t]
        [(gref) (let ([g (cadr e)])
                  (and (not (global-info-mutable? g))
                       (or (external? ms (global-info-instance g)) (memq g earlier) #f)))]
        [(prim) (and (memq (cadr e) '(i32.add i32.sub i32.mul i64.add i64.sub i64.mul))
                     (for-all loop (cadddr e)))]
        [(gc) (and (memq (cadr e) '(struct.new array.new array.new_default array.new_fixed ref.null ref.i31))
                   (for-all loop (cadddr e)))]
        [else #f])))

  (define (loc-of e) (and (pair? e) (eq? (car e) 'at) (cadr e)))

  (define (const-op t) (string->symbol (string-append (symbol->string t) ".const")))

  ;; Every type-info mentioned anywhere in x, dependencies first: its
  ;; supertype, then the types its fields mention. A recursion group comes
  ;; as a unit: the types its members mention outside the group first, then
  ;; the members in order. Outside a group a type may mention itself, but
  ;; not a later type.
  (define (collect-types x)
    (let ([found '()] [visiting '()])
      (define (add! t)
        (unless (or (memq t found) (memq t visiting))
          (let ([members (or (type-info-group t) (list t))])
            (set! visiting (append members visiting))
            (for-each (lambda (m) (walk (type-info-super m)) (walk (type-info-fields m))) members)
            (for-each (lambda (m) (set! found (cons m found))) members))))
      (define (walk x)
        (cond [(type-info? x) (add! x)]
              [(pair? x) (walk (car x)) (walk (cdr x))]
              [(vector? x) (vector-for-each walk x)]
              [else (void)]))
      (walk x)
      (reverse found)))

  ;; forms: fully expanded module forms. self: this module's instance name.
  ;; Assigns instance and export names to the infos it defines. Returns the
  ;; module bytes, the instance names it imports from, and whether its code
  ;; uses GC objects.
  (define (compile-module forms self)
    (define ms (make-mstate self '() '() '() '() #f #f #f))
    (define func-forms (filter (lambda (f) (eq? (car f) 'func)) forms))
    (define global-forms (filter (lambda (f) (eq? (car f) 'global)) forms))
    (define data-forms (filter (lambda (f) (eq? (car f) 'data)) forms))
    (define type-forms (filter (lambda (f) (eq? (car f) 'type)) forms))
    ;; (memory pages) defines memory 0; (memory-import instance) imports the
    ;; memory another instance exports. Tables likewise.
    (define memory-form (find (lambda (f) (memq (car f) '(memory memory-import))) forms))
    (define table-form (find (lambda (f) (memq (car f) '(table table-import))) forms))
    (define (imported? form) (and form (memq (car form) '(memory-import table-import))))
    (define exported (make-hashtable string-hash string=?))

    (define (export-name! name)
      (let loop ([n 0])
        (let ([s (if (zero? n) (symbol->string name) (format "~a.~a" name n))])
          (if (hashtable-contains? exported s)
              (loop (+ n 1))
              (begin (hashtable-set! exported s #t) s)))))

    (define (local name)
      (let ([f (find (lambda (f) (eq? (func-info-name (cadr f)) name)) func-forms)])
        (and f (cadr f))))
    (define (ex name) (syntax-func ms local name))

    (define assigned-funcs
      (for-each (lambda (f)
                  (let ([info (cadr f)])
                    (func-info-instance-set! info self)
                    (func-info-export-set! info (export-name! (func-info-name info)))))
                func-forms))
    (define assigned-globals
      (for-each (lambda (f)
                  (let ([info (cadr f)])
                    (global-info-instance-set! info self)
                    (global-info-export-set! info (export-name! (global-info-name info)))))
                global-forms))

    ;; Global initializers (spec 5.2). A constant expression is compiled
    ;; into the global itself: an alist info -> code, in definition order.
    ;; Any other initializer runs in the start function, so its global must
    ;; be mutable and start with a default value.
    (define constant-inits
      (let loop ([fs global-forms] [earlier '()] [acc '()])
        (if (null? fs)
            (reverse acc)
            (let* ([info (cadr (car fs))] [init (caddr (car fs))] [t (global-info-type info)])
              (parameterize ([current-loc (loc-of init)])
                (cond
                  [(and init (constant-expr? ms init earlier))
                   (let-values ([(c _) (cx ms (new-fctx '() '()) '() init (list t) #f)])
                     (loop (cdr fs) (cons info earlier) (cons (cons info c) acc)))]
                  [(not (global-info-mutable? info))
                   (fail "global ~a is immutable, so its initializer must be a constant expression; declare it (mut ~a) to compute it when the module starts"
                         (global-info-name info) (valtype->string t))]
                  [(not (defaultable? t))
                   (fail "global ~a: a global computed when the module starts must have a numeric or nullable reference type"
                         (global-info-name info))]
                  [else (loop (cdr fs) (cons info earlier) acc)]))))))

    ;; Function bodies.
    (define compiled-funcs
      (map-lr (lambda (f)
                (let* ([info (cadr f)] [params (caddr f)] [body (cadddr f)]
                       [fc (new-fctx params (func-info-results info))])
                  (parameterize ([current-loc #f])
                    (let-values ([(code _) (cx ms fc '() body (func-info-results info) #t)])
                      (list info (list 'func (map cdr params) (func-info-results info))
                            (reverse (fctx-extra fc)) code)))))
              func-forms))

    ;; Start function: run-time global inits and module-level expressions, in
    ;; source order. Compiled before constants are built so it can add some.
    (define start-fc (new-fctx '() '()))
    (define init-code
      (apply append
             (map-lr (lambda (f)
                       (case (car f)
                         [(global)
                          (let ([info (cadr f)] [init (caddr f)])
                            (if (or (not init) (assq info constant-inits))
                                '()
                                (let-values ([(c _) (cx ms start-fc '() init (list (global-info-type info)) #f)])
                                  (append c `((global.set ,info))))))]
                         [(expr)
                          (let-values ([(c _) (cx ms start-fc '() (cadr f) '() #f)]) c)]
                         [else '()]))
                     forms)))
    ;; Table registration for func-index and quoted constants, in the order
    ;; the code above met them.
    (define setup-code
      (apply append
             (map-lr (lambda (s)
                       (if (eq? (synth-kind s) 'fidx)
                           `((ref.func ,(synth-datum s)) (i32.const 1) (table.grow 0) (global.set ,s))
                           (append (build-datum (synth-datum s) ex) `((global.set ,s)))))
                     (reverse (mstate-synths ms)))))
    (define start-code (append setup-code init-code))
    (define has-start? (not (null? start-code)))

    (define checked
      (begin
        (when (and (mstate-uses-memory ms) (not memory-form))
          (raise-compile-error (and (srcloc? (mstate-uses-memory ms)) (mstate-uses-memory ms))
                               "this code uses memory, but the module defines none: add (memory pages)"))
        (when (and (not (null? data-forms)) (not memory-form))
          (fail "data needs a memory: add (memory pages)"))
        (when (and (mstate-uses-table ms) (not table-form))
          (raise-compile-error (and (srcloc? (mstate-uses-table ms)) (mstate-uses-table ms))
                               "this code uses a table, but the module defines none: add (table size)"))))

    ;; ---- index assignment ----
    (define func-imports (reverse (mstate-func-imports ms)))
    (define global-imports (reverse (mstate-global-imports ms)))
    (define synths (reverse (mstate-synths ms)))
    (define n-func-imports (length func-imports))
    (define func-index (make-eq-hashtable))
    (define global-index (make-eq-hashtable))
    (define start-index
      (let loop ([fs (append func-imports (map car compiled-funcs))] [i 0])
        (if (null? fs) i (begin (hashtable-set! func-index (car fs) i) (loop (cdr fs) (+ i 1))))))
    (define n-globals
      (let loop ([gs (append global-imports (map cadr global-forms) synths)] [i 0])
        (if (null? gs) i (begin (hashtable-set! global-index (car gs) i) (loop (cdr gs) (+ i 1))))))

    ;; GC types come first in the type section, dependencies first; function
    ;; types follow as they are needed.
    (define gc-types
      (collect-types (list (map cadr type-forms)
                           (map (lambda (cf) (list (cadr cf) (caddr cf) (cadddr cf))) compiled-funcs)
                           (fctx-extra start-fc) start-code
                           (map (lambda (info) (list (func-info-params info) (func-info-results info) (func-info-type info)))
                                func-imports)
                           (map (lambda (cf) (func-info-type (car cf))) compiled-funcs)
                           (map global-info-type global-imports) (map cdr constant-inits)
                           (map (lambda (f) (global-info-type (cadr f))) global-forms))))
    (define gc-index
      (let ([table (make-eq-hashtable)])
        (let loop ([ts gc-types] [i 0])
          (unless (null? ts) (hashtable-set! table (car ts) i) (loop (cdr ts) (+ i 1))))
        table))
    (define (heap-index h) (if (type-info? h) (hashtable-ref gc-index h #f) h))
    (define (rv t) (if (ref-type? t) (make-ref (ref-nullable? t) (heap-index (ref-heap t))) t))
    (define (rstorage s) (if (memq s '(i8 i16)) s (rv s)))

    (define func-types '())
    (define (type-index sig)
      (let ([sig (list 'func (map rv (cadr sig)) (map rv (caddr sig)))])
        (let loop ([ts func-types] [i (length gc-types)])
          (cond [(null? ts) (set! func-types (append func-types (list sig))) i]
                [(equal? (car ts) sig) i]
                [else (loop (cdr ts) (+ i 1))]))))

    (define (fi info)
      (or (hashtable-ref func-index info #f)
          (fail "internal: function ~a has no index" (func-info-name info))))
    (define (gi g)
      (or (hashtable-ref global-index g #f)
          (fail "internal: global has no index")))
    (define (ti t) (or (hashtable-ref gc-index t #f) (fail "internal: type has no index")))
    ;; A function's type index: its declared function type's, or else its
    ;; signature's.
    (define (func-type-index info sig)
      (if (func-info-type info) (ti (func-info-type info)) (type-index sig)))

    (define declared '())
    (define (resolve instrs)
      (map-lr (lambda (i)
                (case (car i)
                  [(call return_call) (list (car i) (fi (cadr i)))]
                  [(ref.func) (let ([n (fi (cadr i))])
                                (unless (memv n declared) (set! declared (cons n declared)))
                                (list 'ref.func n))]
                  [(global.get global.set) (list (car i) (gi (cadr i)))]
                  [(call_indirect return_call_indirect) (list (car i) (type-index (cadr i)) (caddr i))]
                  [(call_ref return_call_ref) (list (car i) (ti (cadr i)))]
                  [(block loop) (list (car i) (resolve-bt (cadr i)) (resolve (caddr i)))]
                  [(if) (list 'if (resolve-bt (cadr i)) (resolve (caddr i)) (resolve (cadddr i)))]
                  [(select-typed) (list 'select-typed (rv (cadr i)))]
                  [(ref.null) (list 'ref.null (heap-index (cadr i)))]
                  [(ref.test ref.cast) (list (car i) (cadr i) (heap-index (caddr i)))]
                  [(struct.new array.new array.new_default array.get array.get_s array.get_u array.set array.fill)
                   (list (car i) (ti (cadr i)))]
                  [(struct.get struct.get_s struct.get_u struct.set array.new_fixed)
                   (list (car i) (ti (cadr i)) (caddr i))]
                  [(array.copy) (list 'array.copy (ti (cadr i)) (ti (caddr i)))]
                  [else i]))
              instrs))
    (define (resolve-bt bt)
      (cond [(and (pair? bt) (eq? (car bt) 'type)) (list 'type (type-index (cadr bt)))]
            [(null? bt) bt]
            [else (rv bt)]))

    (define imports
      (append
       (map-lr (lambda (info)
                 (list (func-info-instance info) (func-info-export info) 'func
                       (func-type-index info (list 'func (func-info-params info) (func-info-results info)))))
               func-imports)
       (map-lr (lambda (g) (list (global-info-instance g) (global-info-export g) 'global
                                 (list (rv (global-info-type g)) (global-info-mutable? g))))
               global-imports)
       (if (imported? memory-form) (list (list (cadr memory-form) "memory" 'memory '(0 #f))) '())
       (if (imported? table-form) (list (list (cadr table-form) "table" 'table '(0 #f))) '())))

    (define wfuncs
      (append
       (map-lr (lambda (cf)
                 (list (func-type-index (car cf) (cadr cf)) (map rv (caddr cf)) (resolve (cadddr cf))
                       (func-info-export (car cf))))
               compiled-funcs)
       (if has-start?
           (list (list (type-index '(func () ())) (map rv (reverse (fctx-extra start-fc))) (resolve start-code) "__start"))
           '())))

    (define (zero-init t)
      (if (ref-type? t)
          `((ref.null ,(heap-index (ref-heap t))))
          `((,(const-op t) ,(if (memq t '(f32 f64)) 0.0 0)))))

    (define wglobals
      (append
       (map-lr (lambda (f)
                 (let* ([info (cadr f)] [t (global-info-type info)]
                        [init (assq info constant-inits)])
                   (list (rv t) (global-info-mutable? info)
                         (if init (resolve (cdr init)) (zero-init t)))))
               global-forms)
       (map-lr (lambda (s) (if (eq? (synth-kind s) 'fidx)
                               (list 'i32 #t '((i32.const 0)))
                               (list (rv eqref) #t '((ref.null eq)))))
               synths)))

    ;; A module's memory and table are exported as "memory" and "table":
    ;; host imports find the caller's memory that way (spec section 4).
    (define exports
      (append
       (map-lr (lambda (cf) (list (func-info-export (car cf)) 'func (fi (car cf)))) compiled-funcs)
       (map-lr (lambda (f) (list (global-info-export (cadr f)) 'global (gi (cadr f)))) global-forms)
       (if memory-form '(("memory" memory 0)) '())
       (if table-form '(("table" table 0)) '())))

    (define names
      (append
       (map-lr (lambda (info) (cons (fi info) (format "~a.~a" (func-info-instance info) (func-info-export info))))
               func-imports)
       (let loop ([fs wfuncs] [i n-func-imports])
         (if (null? fs) '() (cons (cons i (cadddr (car fs))) (loop (cdr fs) (+ i 1)))))))

    (define (type-entry t)
      (list 'sub (type-info-final? t)
            (if (type-info-super t) (list (heap-index (type-info-super t))) '())
            (case (type-info-kind t)
              [(struct) (list 'struct (map (lambda (f) (list (rstorage (cadr f)) (caddr f))) (type-info-fields t)))]
              [(array) (list 'array (list (rstorage (car (type-info-fields t))) (cadr (type-info-fields t))))]
              [(func) (list 'func (map rv (car (type-info-fields t))) (map rv (cadr (type-info-fields t))))])))

    ;; One entry per recursion group: collect-types keeps a group's members
    ;; together and in order.
    (define gc-type-entries
      (let loop ([ts gc-types] [acc '()])
        (cond [(null? ts) (reverse acc)]
              [(type-info-group (car ts))
               => (lambda (g)
                    (let ([n (length g)])
                      (loop (list-tail ts n) (cons (cons 'rec (map-lr type-entry (list-head ts n))) acc))))]
              [else (loop (cdr ts) (cons (type-entry (car ts)) acc))])))

    (define bytes
      (encode-module
       (make-wmodule (append gc-type-entries func-types) imports
                     (map-lr (lambda (f) (list (car f) (cadr f) (caddr f) (cadddr f))) wfuncs)
                     (if (and table-form (not (imported? table-form))) (list (list (cadr table-form) #f)) '())
                     (if (and memory-form (not (imported? memory-form))) (list (list (cadr memory-form) #f)) '())
                     wglobals exports
                     (and has-start? start-index)
                     (reverse declared)
                     (map-lr (lambda (f) (cons (data-info-offset (cadr f)) (data-info-bytes (cadr f)))) data-forms)
                     (cons self names))))

    (values bytes
            (let loop ([is imports] [acc '()])
              (cond [(null? is) (reverse acc)]
                    [(member (caar is) acc) (loop (cdr is) acc)]
                    [else (loop (cdr is) (cons (caar is) acc))]))
            (or (mstate-uses-gc ms) (exists (lambda (t) (not (func-type? t))) gc-types)))))
