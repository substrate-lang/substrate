;; Compiler: fully expanded kernel forms (see core.sls) -> wasm module bytes.
;;
;; Expressions are compiled to symbolic instructions that mention info
;; records instead of indices; a final pass assigns indices once every
;; import and synthesized global is known.
(library (stage0 compile)
  (export compile-module current-rt-infos immediate-word fixnum-min fixnum-max)
  (import (chezscheme) (stage0 syntax) (stage0 core) (stage0 ops) (stage0 wasm))

  ;; symbol -> func-info for rt's exports; #f while compiling rt itself.
  (define current-rt-infos (make-parameter #f))

  (define fixnum-min (- (expt 2 30)))
  (define fixnum-max (- (expt 2 30) 1))

  ;; The value word of an immediate datum (spec 2.2), or #f if d lives in
  ;; the heap.
  (define (immediate-word d)
    (cond [(and (integer? d) (exact? d))
           (unless (<= fixnum-min d fixnum-max)
             (raise-compile-error (current-loc) "integer ~a is outside the fixnum range" d))
           (+ (* 2 d) 1)]
          [(eq? d #f) 0]
          [(eq? d #t) 10]
          [(null? d) 18]
          [(eq? d (void)) 26]
          [(eof-object? d) 34]
          [(char? d) (+ (* 8 (char->integer d)) 4)]
          [else #f]))

  ;; ---- error locations ------------------------------------------------------

  (define current-loc (make-parameter #f))
  (define (fail fmt . args) (apply raise-compile-error (current-loc) fmt args))

  ;; ---- types ------------------------------------------------------------------

  (define (type->string t)
    (cond [(eq? t 'bottom) "nothing (unreachable)"]
          [(null? t) "no value"]
          [(null? (cdr t)) (symbol->string (car t))]
          [else (format "~a" t)]))

  (define (single? t) (and (pair? t) (null? (cdr t))))

  ;; Make code of type `type` fit `expected`: drop unused values, or fail.
  (define (coerce code type expected)
    (cond [(not expected) (values code type)]
          [(eq? type 'bottom) (values code expected)]
          [(equal? type expected) (values code type)]
          [(null? expected) (values (append code (map-lr (lambda (_) '(drop)) type)) '())]
          [else (fail "type mismatch: expected ~a, got ~a" (type->string expected) (type->string type))]))

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
            (mutable data)))         ; list of bytevectors, reversed (one segment)

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

  (define (new-synth! ms kind datum)
    (let ([s (make-synth kind datum)])
      (mstate-synths-set! ms (cons s (mstate-synths ms)))
      s))

  (define (fidx-synth! ms info)
    (cond [(assq info (mstate-fidx ms)) => cdr]
          [else (let ([s (new-synth! ms 'fidx info)])
                  (note-func! ms info)
                  (mstate-fidx-set! ms (cons (cons info s) (mstate-fidx ms)))
                  s)]))

  ;; Append bytes to the passive data segment; returns their offset.
  (define (add-data! ms bv)
    (let ([offset (apply + (map bytevector-length (mstate-data ms)))])
      (mstate-data-set! ms (cons bv (mstate-data ms)))
      offset))

  ;; ---- expressions ------------------------------------------------------------

  (define (rt-func ms rt-local name)
    (let ([info (if (current-rt-infos)
                    (hashtable-ref (current-rt-infos) name #f)
                    (rt-local name))])
      (unless info (fail "internal: rt has no function ~a" name))
      (note-func! ms info)
      info))

  ;; Compile e. expected: #f or a list of valtypes. tail?: e's value is the
  ;; function's return value. Returns (values code type).
  (define (cx ms fc labels e expected tail? rt-local)
    (define (sub e expected tail?) (cx ms fc labels e expected tail? rt-local))
    (define (sub-in labels e expected tail?) (cx ms fc labels e expected tail? rt-local))
    (define (args-code args types)
      (unless (= (length args) (length types))
        (fail "expected ~a arguments, got ~a" (length types) (length args)))
      (apply append (map-lr (lambda (a t) (let-values ([(c _) (sub a (list t) #f)]) c)) args types)))
    (define (blocktype t)
      (cond [(null? t) '()]
            [(single? t) (car t)]
            [else (list 'type (cons '() t))]))
    (define (finish code type) (coerce code type expected))
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
         (let-values ([(c _) (sub v (list (cdr l)) #f)])
           (finish (append c `((local.set ,(car l)))) '())))]
      [(gref) (info)
       (note-global! ms info)
       (finish `((global.get ,info)) (list (global-info-type info)))]
      [(gset) (info v)
       (note-global! ms info)
       (let-values ([(c _) (sub v (list (global-info-type info)) #f)])
         (finish (append c `((global.set ,info))) '()))]
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
                             [(c2 t2) (sub-in lbls els (if (eq? t1 'bottom) expected t1) tail?)])
                 (let ([t (cond [(not (eq? t1 'bottom)) t1]
                                [(not (eq? t2 'bottom)) t2]
                                [expected expected]
                                [else '()])])
                   (values (append tc `((if ,(blocktype t) ,c1 ,c2))) t))))))]
      [(block) (key body)
       (let* ([lbl (make-label key 'block expected)])
         (let-values ([(c t) (sub-in (cons lbl labels) body expected tail?)])
           (let ([t (cond [(not (eq? t 'bottom))
                           (when (and (label-type lbl) (not (equal? (label-type lbl) t)))
                             (fail "block result is ~a but a br carries ~a"
                                   (type->string t) (type->string (label-type lbl))))
                           t]
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
                     [(not (equal? (label-type lbl) t))
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
         (if (and tail? (equal? results (fctx-results fc)))
             (values (append code `((return_call ,info))) results)
             (finish (append code `((call ,info))) results)))]
      [(prim) (name offset args)
       (let ([p (lookup-prim name)])
         (let ([code (args-code args (prim-op-params p))])
           (finish (append code
                           (if (eq? (prim-op-kind p) 'mem)
                               `((,name ,(prim-op-align p) ,(or offset 0)))
                               `((,name))))
                   (prim-op-results p))))]
      [(call-indirect) (params results idx args)
       (let* ([code (args-code args params)]
              [ic (let-values ([(c _) (sub idx '(i32) #f)]) c)]
              [sig (cons params results)])
         (if (and tail? (equal? results (fctx-results fc)))
             (values (append code ic `((return_call_indirect ,sig 0))) results)
             (finish (append code ic `((call_indirect ,sig 0))) results)))]
      [(func-index) (info)
       (finish `((global.get ,(fidx-synth! ms info))) '(i32))]
      [(select) (a b test)
       (let*-values ([(ca ta) (sub a #f #f)])
         (unless (single? ta) (fail "select needs single values, got ~a" (type->string ta)))
         (let-values ([(cb _b) (sub b ta #f)] [(ct _t) (sub test '(i32) #f)])
           (finish (append ca cb ct '((select))) ta)))]
      [(drop) (v)
       (let-values ([(c t) (sub v #f #f)])
         (finish (if (eq? t 'bottom) c (append c (map-lr (lambda (_) '(drop)) t))) '()))]
      [(unreachable) () (values '((unreachable)) 'bottom)]
      [(nop) () (finish '((nop)) '())]
      [(quote) (d)
       (let ([w (immediate-word d)])
         (if w
             (finish `((i32.const ,w)) '(i32))
             (finish `((global.get ,(new-synth! ms 'const d))) '(i32))))]
      [else (fail "internal: unknown kernel form ~s" (car e))]))

  ;; ---- quoted constants ---------------------------------------------------------

  ;; Code that builds datum d in the heap and leaves its word on the stack.
  ;; tmp is a scratch local of the start function.
  (define (build-datum ms d tmp rt)
    (define (call name) `((call ,(rt name))))
    (define (build d) (build-datum ms d tmp rt))
    (define (string-code s)
      (let* ([bv (string->utf8 s)]
             [n (bytevector-length bv)]
             [off (add-data! ms bv)])
        `((i32.const ,n) ,@(call 'alloc-string) (local.set ,tmp)
          (local.get ,tmp) (i32.const 4) (i32.add) (i32.const ,off) (i32.const ,n) (memory.init 0)
          (local.get ,tmp))))
    (let ([w (immediate-word d)])
      (cond [w `((i32.const ,w))]
            [(string? d) (string-code d)]
            [(symbol? d) (append (string-code (symbol->string d)) (call 'intern))]
            [(pair? d) (append (build (car d)) (build (cdr d)) (call 'cons))]
            [(vector? d) (append (build (vector->list d)) (call 'list->vector))]
            [(stx? d) (append (build (stx-e d)) (build (stx-scopes d))
                              (build (stx-srcloc d)) (build (stx-props d)) (call 'make-syntax))]
            [(srcloc? d) (append (build (srcloc-source d)) (build (srcloc-line d)) (build (srcloc-col d))
                                 (build (srcloc-pos d)) (build (srcloc-span d)) (call 'make-srcloc))]
            [else (fail "cannot quote ~s" d)])))

  ;; ---- module -------------------------------------------------------------------

  (define (literal-init init)
    (let loop ([init init])
      (and (pair? init)
           (case (car init)
             [(at) (loop (caddr init))]
             [(int) (cadr init)]
             [(float) (cadr init)]
             [(const) (caddr init)]
             [(quote) (immediate-word (cadr init))]
             [else #f]))))

  (define (valtype-zero t) (case t [(i32 i64) 0] [else 0.0]))

  (define (const-op t) (string->symbol (string-append (symbol->string t) ".const")))

  (define (concat-bytevectors bvs)
    (let ([out (make-bytevector (apply + (map bytevector-length bvs)))])
      (let loop ([bvs bvs] [i 0])
        (if (null? bvs)
            out
            (let ([n (bytevector-length (car bvs))])
              (bytevector-copy! (car bvs) 0 out i n)
              (loop (cdr bvs) (+ i n)))))))

  ;; forms: fully expanded module forms. self: this module's instance name.
  ;; Assigns instance and export names to the infos it defines. Returns the
  ;; module bytes.
  (define (compile-module forms self)
    (define ms (make-mstate self '() '() '() '() '()))
    (define func-forms (filter (lambda (f) (eq? (car f) 'func)) forms))
    (define global-forms (filter (lambda (f) (eq? (car f) 'global)) forms))
    (define memory-form (find (lambda (f) (eq? (car f) 'memory)) forms))
    (define table-form (find (lambda (f) (eq? (car f) 'table)) forms))
    (define exported (make-hashtable string-hash string=?))

    (define (export-name! name)
      (let loop ([n 0])
        (let ([s (if (zero? n) (symbol->string name) (format "~a.~a" name n))])
          (if (hashtable-contains? exported s)
              (loop (+ n 1))
              (begin (hashtable-set! exported s #t) s)))))

    (define (rt-local name)
      (let ([f (find (lambda (f) (eq? (func-info-name (cadr f)) name)) func-forms)])
        (and f (cadr f))))
    (define (rt name) (rt-func ms rt-local name))

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

    ;; Function bodies.
    (define compiled-funcs
      (map-lr (lambda (f)
             (let* ([info (cadr f)] [params (caddr f)] [body (cadddr f)]
                    [fc (new-fctx params (func-info-results info))])
               (parameterize ([current-loc #f])
                 (let-values ([(code _) (cx ms fc '() body (func-info-results info) #t rt-local)])
                   (list info (cons (map cdr params) (func-info-results info))
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
                         (if (or (not init) (literal-init init))
                             '()
                             (let-values ([(c _) (cx ms start-fc '() init (list (global-info-type info)) #f rt-local)])
                               (append c `((global.set ,info))))))]
                      [(expr)
                       (let-values ([(c _) (cx ms start-fc '() (cadr f) '() #f rt-local)]) c)]
                      [else '()]))
                  forms)))
    ;; Table registration for func-index, then constants. Building constants
    ;; can add more constants (none today) and more rt imports.
    (define tmp (temp-local! start-fc 'i32))
    (define setup-code
      (let loop ([done '()] [code '()])
        (let ([todo (filter (lambda (s) (not (memq s done))) (reverse (mstate-synths ms)))])
          (if (null? todo)
              code
              (loop (append done todo)
                    (append code
                            (apply append
                                   (map-lr (lambda (s)
                                          (if (eq? (synth-kind s) 'fidx)
                                              `((ref.func ,(synth-datum s)) (i32.const 1) (table.grow 0)
                                                (global.set ,s))
                                              (append (build-datum ms (synth-datum s) tmp rt)
                                                      `((global.set ,s)))))
                                        todo))))))))
    (define start-code (append setup-code init-code))
    (define has-start? (not (null? start-code)))

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

    (define types '())
    (define (type-index sig)
      (let loop ([ts types] [i 0])
        (cond [(null? ts) (set! types (append types (list sig))) i]
              [(equal? (car ts) sig) i]
              [else (loop (cdr ts) (+ i 1))])))

    (define (fi info)
      (or (hashtable-ref func-index info #f)
          (fail "internal: function ~a has no index" (func-info-name info))))
    (define (gi g)
      (or (hashtable-ref global-index g #f)
          (fail "internal: global has no index")))

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
               [(block loop) (list (car i) (resolve-bt (cadr i)) (resolve (caddr i)))]
               [(if) (list 'if (resolve-bt (cadr i)) (resolve (caddr i)) (resolve (cadddr i)))]
               [else i]))
           instrs))
    (define (resolve-bt bt)
      (if (and (pair? bt) (eq? (car bt) 'type)) (list 'type (type-index (cadr bt))) bt))

    (define imports
      (append
       (map-lr (lambda (info)
              (list (func-info-instance info) (func-info-export info) 'func
                    (type-index (cons (func-info-params info) (func-info-results info)))))
            func-imports)
       (if memory-form '() '(("rt" "mem" memory (1 #f))))
       (if table-form '() '(("rt" "tbl" table (1 #f))))
       (map-lr (lambda (g) (list (global-info-instance g) (global-info-export g) 'global
                              (list (global-info-type g) #t)))
            global-imports)))

    (define wfuncs
      (append
       (map-lr (lambda (cf)
              (list (type-index (cadr cf)) (caddr cf) (resolve (cadddr cf))
                    (func-info-export (car cf))))
            compiled-funcs)
       (if has-start?
           (list (list (type-index '(() . ())) (reverse (fctx-extra start-fc)) (resolve start-code) "__start"))
           '())))

    (define wglobals
      (append
       (map-lr (lambda (f)
              (let* ([info (cadr f)] [t (global-info-type info)] [lit (and (caddr f) (literal-init (caddr f)))])
                (list t #t (list (list (const-op t)
                                       (cond [(not lit) (valtype-zero t)]
                                             [(memq t '(f32 f64)) (inexact lit)]
                                             [(eq? t 'i32) (s32 lit)]
                                             [else (s64 lit)]))))))
            global-forms)
       (map-lr (lambda (s) (list 'i32 #t '((i32.const 0)))) synths)))

    (define exports
      (append
       (map-lr (lambda (cf) (list (func-info-export (car cf)) 'func (fi (car cf)))) compiled-funcs)
       (map-lr (lambda (f) (list (global-info-export (cadr f)) 'global (gi (cadr f)))) global-forms)
       (if memory-form (list (list (symbol->string (cadr memory-form)) 'memory 0)) '())
       (if table-form (list (list (symbol->string (cadr table-form)) 'table 0)) '())))

    (define names
      (append
       (map-lr (lambda (info) (cons (fi info) (format "~a.~a" (func-info-instance info) (func-info-export info))))
            func-imports)
       (let loop ([fs wfuncs] [i n-func-imports])
         (if (null? fs) '() (cons (cons i (cadddr (car fs))) (loop (cdr fs) (+ i 1)))))))

    (define data (reverse (mstate-data ms)))

    (encode-module
     (make-wmodule types imports
                   (map-lr (lambda (f) (list (car f) (cadr f) (caddr f) (cadddr f))) wfuncs)
                   (if table-form (list (list (caddr table-form) #f)) '())
                   (if memory-form (list (list (caddr memory-form) #f)) '())
                   wglobals exports
                   (and has-start? start-index)
                   (reverse declared)
                   (if (null? data) '() (list (concat-bytevectors data)))
                   (cons self names)))))
