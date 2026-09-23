;; Expander: syntax objects -> fully expanded kernel forms (core.sls).
;;
;; Binding is by sets of scopes (spec 6.1). Phase >= 1 code is compiled
;; into chunks and run in the compile-time store as expansion goes
;; (spec 3.2). Macros are procedures in that store (spec 6.2).
(library (stage0 expander)
  (export make-session session-rt-bytes session-store compile-source expand-source
          strip-ast)
  (import (chezscheme) (stage0 syntax) (stage0 core) (stage0 ops) (stage0 compile)
          (stage0 host) (stage0 marshal) (stage0 reader))

  ;; ==== sessions ==============================================================
  ;;
  ;; A session is one compile-time store with rt instantiated in it, plus
  ;; the rt interface every module is expanded against.

  (define-record-type (session new-session session?) (fields store rt-bytes rt-infos))

  (define core-forms
    '(func global import memory table define-syntax begin-for-syntax begin
      set! let let* if block loop br br-if return call-indirect func-index
      select drop unreachable nop quote quasiquote unquote unquote-splicing
      quote-syntax quasisyntax unsyntax unsyntax-splicing))

  ;; The expander API (spec 6.3), visible at phase >= 1.
  (define expander-api
    (list (make-func-info 'syntax-local-value '(i32) '(i32) "expander" "syntax-local-value")
          (make-func-info 'syntax-error '(i32 i32) '(i32) "expander" "syntax-error")
          (make-func-info 'free-identifier=? '(i32 i32) '(i32) "expander" "free-identifier=?")))

  ;; rt-path: the kernel source of rt. Compiles it, starts a compile-time
  ;; store and instantiates rt there.
  (define (make-session rt-path)
    (let* ([h (host-new)]
           [st (make-store h)])
      (host-set-callback! h expander-callback)
      (let-values ([(forms infos) (parameterize ([current-rt-infos #f])
                                    (expand-module (read-file rt-path) 'rt #f st))])
        (let ([bytes (parameterize ([current-rt-infos #f]) (compile-module forms "rt"))]
              [table (make-eq-hashtable)])
          (for-each (lambda (info) (hashtable-set! table (func-info-name info) info)) infos)
          (host-instantiate! h "rt" bytes)
          (new-session st bytes table)))))

  ;; Expand and compile one source file; returns the phase-0 module bytes.
  (define (compile-source sess path)
    (parameterize ([current-rt-infos (session-rt-infos sess)])
      (let-values ([(forms _) (expand-module (read-file path) (module-name path) #t (session-store sess))])
        (compile-module forms "main"))))

  (define (expand-source sess path)
    (parameterize ([current-rt-infos (session-rt-infos sess)])
      (let-values ([(forms _) (expand-module (read-file path) (module-name path) #t (session-store sess))])
        forms)))

  (define (module-name path)
    (let* ([base (let loop ([cs (reverse (string->list path))] [acc '()])
                   (if (or (null? cs) (char=? (car cs) #\/)) (list->string acc) (loop (cdr cs) (cons (car cs) acc))))]
           [dot (let loop ([i (- (string-length base) 1)])
                  (cond [(< i 0) #f] [(char=? (string-ref base i) #\.) i] [else (loop (- i 1))]))])
      (string->symbol (if dot (substring base 0 dot) base))))

  ;; ==== per-module expansion state =============================================

  (define bindings (make-eq-hashtable))    ; symbol -> list of binding
  (define meanings (make-eqv-hashtable))   ; key -> meaning
  (define scope-counter 0)
  (define chunk-counter 0)
  (define current-module 'main)
  (define current-store #f)

  ;; phase: an integer, 'all, or 'meta (every phase >= 1)
  (define-record-type binding (fields scopes phase key))

  ;; meaning: (core name) (prim name) (func info) (global info) (local key)
  ;;          (label key) (macro word)

  (define (reset-state! module st)
    (set! bindings (make-eq-hashtable))
    (set! meanings (make-eqv-hashtable))
    (set! scope-counter 0)
    (set! chunk-counter 0)
    (set! current-module module)
    (set! current-store st)
    (reset-keys!))

  (define (new-scope!) (set! scope-counter (+ scope-counter 1)) scope-counter)

  (define core-scope 0)

  (define (bind-raw! sym scopes phase meaning)
    (let ([key (fresh-key!)])
      (hashtable-update! bindings sym (lambda (l) (cons (make-binding scopes phase key) l)) '())
      (hashtable-set! meanings key meaning)
      key))

  (define (bind! id phase meaning) (bind-raw! (stx-e id) (stx-scopes id) phase meaning))

  (define (phase-matches? b phase)
    (let ([p (binding-phase b)])
      (or (eq? p 'all) (and (eq? p 'meta) (>= phase 1)) (eqv? p phase))))

  ;; The key id refers to at phase, or #f if unbound.
  (define (resolve id phase)
    (let* ([scopes (stx-scopes id)]
           [cands (filter (lambda (b) (and (phase-matches? b phase) (scopes-subset? (binding-scopes b) scopes)))
                          (hashtable-ref bindings (stx-e id) '()))])
      (if (null? cands)
          #f
          (let ([best (fold-left (lambda (best b)
                                   (if (> (length (binding-scopes b)) (length (binding-scopes best))) b best))
                                 (car cands) (cdr cands))])
            (for-each (lambda (b)
                        (unless (scopes-subset? (binding-scopes b) (binding-scopes best))
                          (raise-compile-error id "identifier ~a is ambiguous" (stx-e id))))
                      cands)
            (binding-key best)))))

  (define (meaning-of id phase)
    (let ([key (resolve id phase)])
      (and key (hashtable-ref meanings key #f))))

  ;; Is id bound to the core form `name`?
  (define (core-id? id name phase)
    (and (id? id)
         (let ([m (meaning-of id phase)])
           (and m (eq? (car m) 'core) (eq? (cadr m) name)))))

  (define (install-base! rt-infos)
    (for-each (lambda (name) (bind-raw! name (list core-scope) 'all (list 'core name))) core-forms)
    (for-each (lambda (name) (bind-raw! name (list core-scope) 'all (list 'prim name))) (prim-names))
    (when rt-infos
      (let-values ([(names infos) (hashtable-entries rt-infos)])
        ;; sort for deterministic keys
        (for-each (lambda (info) (bind-raw! (func-info-name info) (list core-scope) 'all (list 'func info)))
                  (list-sort (lambda (a b) (string<? (symbol->string (func-info-name a))
                                                      (symbol->string (func-info-name b))))
                             (vector->list infos))))
      (for-each (lambda (info) (bind-raw! (func-info-name info) (list core-scope) 'meta (list 'func info)))
                expander-api)))

  ;; ==== module bodies ============================================================

  ;; Expand a module. with-rt?: bind rt's functions (#f only for rt itself).
  ;; Returns (values phase-0-forms defined-func-infos).
  (define (expand-module forms module with-rt? st)
    (reset-state! module st)
    (install-base! (and with-rt? (current-rt-infos)))
    (let* ([msc (new-scope!)]
           [forms (map-lr (lambda (f) (add-scope (add-scope f core-scope) msc)) forms)]
           [out (expand-body forms 0)])
      (values out (map cadr (filter (lambda (f) (eq? (car f) 'func)) out)))))

  (define (stx-list-of s who)
    (or (stx->list s) (raise-compile-error s "bad ~a form" who)))

  ;; The core form name if s is (core-id ...), else #f.
  (define (core-head s phase)
    (and (stx? s) (pair? (stx-e s)) (id? (car (stx-e s)))
         (let ([m (meaning-of (car (stx-e s)) phase)])
           (and m (eq? (car m) 'core) (cadr m)))))

  ;; Expand macro uses at the head of s until it is something else.
  (define (head-expand s phase)
    (let ([head (cond [(id? s) s]
                      [(and (pair? (stx-e s)) (id? (car (stx-e s)))) (car (stx-e s))]
                      [else #f])])
      (let ([m (and head (meaning-of head phase))])
        (if (and m (eq? (car m) 'macro))
            (head-expand (apply-macro head (cadr m) s phase) phase)
            s))))

  (define (expand-body forms phase)
    ;; Pass 1: find definitions, run compile-time forms, splice begins.
    (let loop ([forms forms] [pending '()])
      (if (pair? forms)
          (let* ([f (head-expand (car forms) phase)]
                 [rest (cdr forms)])
            (case (core-head f phase)
              [(begin) (loop (append (cdr (stx-list-of f 'begin)) rest) pending)]
              [(func) (loop rest (cons (declare-func f phase) pending))]
              [(global) (loop rest (cons (declare-global f phase) pending))]
              [(import) (declare-import f phase) (loop rest pending)]
              [(memory table) (loop rest (cons (list 'plain (parse-memory f)) pending))]
              [(define-syntax) (define-syntax! f phase) (loop rest pending)]
              [(begin-for-syntax) (begin-for-syntax! f phase) (loop rest pending)]
              [else (loop rest (cons (list 'expr f) pending))]))
          ;; Pass 2: expand bodies and expressions.
          (map-lr (lambda (p)
                 (case (car p)
                   [(func) (expand-func p phase)]
                   [(global) (list 'global (cadr p) (and (caddr p) (expand-expr (caddr p) phase)))]
                   [(plain) (cadr p)]
                   [(expr) (list 'expr (expand-expr (cadr p) phase))]))
               (reverse pending)))))

  (define (parse-type s)
    (let ([t (and (id? s) (stx-e s))])
      (unless (memq t '(i32 i64 f32 f64))
        (raise-compile-error s "expected a type (i32, i64, f32 or f64), got ~s" (stx->datum s)))
      t))

  ;; `-> t` or `-> (t ...)`; returns the result list and the rest of body.
  (define (parse-results body)
    (if (and (pair? body) (id? (car body)) (eq? (stx-e (car body)) '->))
        (begin
          (when (null? (cdr body)) (raise-compile-error (car body) "expected a type after ->"))
          (let ([r (cadr body)])
            (values (if (stx->list r) (map-lr parse-type (stx->list r)) (list (parse-type r)))
                    (cddr body))))
        (values '() body)))

  ;; (t ... -> r ...)
  (define (parse-signature s)
    (let* ([parts (stx-list-of s "signature")]
           [arrow (let loop ([ps parts] [i 0])
                    (cond [(null? ps) (raise-compile-error s "a signature needs ->")]
                          [(and (id? (car ps)) (eq? (stx-e (car ps)) '->)) i]
                          [else (loop (cdr ps) (+ i 1))]))])
      (values (map-lr parse-type (list-head parts arrow))
              (map-lr parse-type (list-tail parts (+ arrow 1))))))

  ;; (func (name [p t] ...) [-> r] body ...)
  (define (declare-func f phase)
    (let* ([parts (stx-list-of f 'func)]
           [head (if (>= (length parts) 2) (cadr parts) (raise-compile-error f "func needs a name and parameters"))]
           [hparts (stx-list-of head "func head")])
      (unless (and (pair? hparts) (id? (car hparts)))
        (raise-compile-error head "expected (name [param type] ...)"))
      (let* ([name (car hparts)]
             [params (map-lr (lambda (p)
                            (let ([pp (stx->list p)])
                              (unless (and pp (= (length pp) 2) (id? (car pp)))
                                (raise-compile-error p "expected [name type]"))
                              (cons (car pp) (parse-type (cadr pp)))))
                          (cdr hparts))])
        (let-values ([(results body) (parse-results (cddr parts))])
          (let ([info (make-func-info (stx-e name) (map cdr params) results #f #f)])
            (bind! name phase (list 'func info))
            (list 'func info params body f))))))

  (define (expand-func p phase)
    (let* ([info (list-ref p 1)] [params (list-ref p 2)] [body (list-ref p 3)] [f (list-ref p 4)]
           [sc (new-scope!)]
           [keys (map-lr (lambda (pr) (bind! (add-scope (car pr) sc) phase (list 'local #f))) params)])
      (for-each (lambda (k) (hashtable-set! meanings k (list 'local k))) keys)
      (list 'func info (map-lr (lambda (k pr) (cons k (cdr pr))) keys params)
            (expand-seq (map-lr (lambda (b) (add-scope b sc)) body) phase f))))

  ;; (global name type init)
  (define (declare-global f phase)
    (let ([parts (stx-list-of f 'global)])
      (unless (and (= (length parts) 4) (id? (cadr parts)))
        (raise-compile-error f "expected (global name type init)"))
      (let ([info (make-global-info (stx-e (cadr parts)) (parse-type (caddr parts)) #f #f)])
        (bind! (cadr parts) phase (list 'global info))
        (list 'global info (cadddr parts)))))

  ;; (import name "module" "field" (t ... -> r ...))
  (define (declare-import f phase)
    (let ([parts (stx-list-of f 'import)])
      (unless (and (= (length parts) 5) (id? (cadr parts))
                   (string? (stx-e (caddr parts))) (string? (stx-e (cadddr parts))))
        (raise-compile-error f "expected (import name \"module\" \"field\" (type ... -> type ...))"))
      (let-values ([(params results) (parse-signature (list-ref parts 4))])
        (bind! (cadr parts) phase
               (list 'func (make-func-info (stx-e (cadr parts)) params results
                                           (stx-e (caddr parts)) (stx-e (cadddr parts))))))))

  ;; (memory name pages) / (table name size)
  (define (parse-memory f)
    (let ([parts (stx-list-of f 'memory)])
      (unless (and (= (length parts) 3) (id? (cadr parts)) (fixnum? (stx-e (caddr parts))))
        (raise-compile-error f "expected (~a name size)" (stx-e (car parts))))
      (list (stx-e (car parts)) (stx-e (cadr parts)) (stx-e (caddr parts)))))

  ;; ==== compile-time evaluation ===================================================

  (define (next-chunk-name! phase)
    (let ([n chunk-counter])
      (set! chunk-counter (+ n 1))
      (format "~a@~a#~a" current-module phase n)))

  (define (run-chunk! forms phase where)
    (let* ([name (next-chunk-name! phase)]
           [bytes (compile-module forms name)])
      (guard (c [(wasm-failure? c)
                 (raise-compile-error where "compile-time code failed: ~a" (wasm-failure-message c))])
        (host-instantiate! (store-host current-store) name bytes))
      name))

  ;; (define-syntax name expr)
  (define (define-syntax! f phase)
    (let ([parts (stx-list-of f 'define-syntax)])
      (unless (and (= (length parts) 3) (id? (cadr parts)))
        (raise-compile-error f "expected (define-syntax name expr)"))
      (let* ([rhs (expand-expr (caddr parts) (+ phase 1))]
             [thunk (make-func-info '__rhs '() '(i32) #f #f)]
             [chunk (run-chunk! (list (list 'func thunk '() rhs)) (+ phase 1) f)]
             [word (call-in-store f (lambda (h) (host-call h chunk (func-info-export thunk))))])
        (bind! (cadr parts) phase (list 'macro word)))))

  ;; (begin-for-syntax form ...)
  (define (begin-for-syntax! f phase)
    (let ([forms (expand-body (cdr (stx-list-of f 'begin-for-syntax)) (+ phase 1))])
      (run-chunk! forms (+ phase 1) f)))

  ;; ==== macros ======================================================================

  ;; State the expander API callbacks read.
  (define api-phase 0)
  (define api-where #f)               ; the form the running macro was given
  (define api-error #f)

  (define (call-in-store where proc)
    (set! api-error #f)
    (guard (c [(wasm-failure? c)
               (if api-error
                   (let ([e api-error]) (set! api-error #f) (raise e))
                   (raise-compile-error where "~a" (wasm-failure-message c)))])
      (flush-output-port (current-output-port))
      (proc (store-host current-store))))

  (define (apply-macro head word s phase)
    (let ([index (proc-index current-store word)])
      (unless index
        (raise-compile-error s "~a is bound at compile time but is not a macro" (stx-e head)))
      (let ([saved-phase api-phase] [saved-where api-where])
        (dynamic-wind
          (lambda () (set! api-phase phase) (set! api-where s))
          (lambda ()
            (let* ([in (encode current-store s)]
                   [out (call-in-store s (lambda (h) (host-call-index h index in)))]
                   [result (decode current-store out)])
              (unless (stx? result)
                (raise-compile-error s "macro ~a returned a non-syntax value: ~s" (stx-e head)
                                     (stx->datum result)))
              result))
          (lambda () (set! api-phase saved-phase) (set! api-where saved-where))))))

  ;; Entry point for wasm calls to the expander API (spec 6.3). Must never
  ;; raise: an exception here would unwind through C and wasm frames.
  (define (expander-callback op a b)
    (guard (c [#t (set! api-error
                        (if (compile-error? c)
                            c
                            (condition (make-error) (make-message-condition
                                                     (if (message-condition? c)
                                                         (condition-message c)
                                                         (format "~s" c))))))
                  (host-request-trap! (store-host current-store) "expander API call failed")
                  0])
      (case op
        [(1)                            ; syntax-local-value
         (let ([id (decode current-store a)])
           (let ([m (and (id? id) (meaning-of id api-phase))])
             (if (and m (eq? (car m) 'macro)) (cadr m) 0)))]
        [(2)                            ; syntax-error
         (let ([s (decode current-store a)] [msg (decode current-store b)])
           (raise-compile-error (if (and (stx? s) (stx-srcloc s)) s api-where) "~a~a" (if (string? msg) msg (format "~s" msg))
                                (if (stx? s) (format "\n  in: ~s" (stx->datum s)) "")))]
        [(3)                            ; free-identifier=?
         (let ([x (decode current-store a)] [y (decode current-store b)])
           (unless (and (id? x) (id? y)) (raise-compile-error api-where "free-identifier=?: expected identifiers"))
           (let ([kx (resolve x api-phase)] [ky (resolve y api-phase)])
             (if (if (or kx ky) (eqv? kx ky) (eq? (stx-e x) (stx-e y))) 10 0)))]
        [else (raise-compile-error api-where "unknown expander API op ~a" op)])))

  ;; ==== expressions ===================================================================

  (define (at s ast) (list 'at (stx-srcloc s) ast))

  (define (expand-seq forms phase where)
    (if (null? forms)
        (at where '(seq))
        (at where (cons 'seq (map-lr (lambda (f) (expand-expr f phase)) forms)))))

  (define (rt-call name . args)
    (let ([info (and (current-rt-infos) (hashtable-ref (current-rt-infos) name #f))])
      (unless info (raise-compile-error #f "this form needs rt (~a)" name))
      (list 'call info args)))

  (define (expand-expr s phase)
    (let ([e (stx-e s)])
      (cond
        [(symbol? e)
         (let ([m (meaning-of s phase)])
           (case (and m (car m))
             [(local) (at s (list 'lref (cadr m)))]
             [(global) (at s (list 'gref (cadr m)))]
             [(macro) (expand-expr (apply-macro s (cadr m) s phase) phase)]
             [(func) (raise-compile-error s "~a is a function: call it, or use (func-index ~a)" e e)]
             [(core prim) (raise-compile-error s "bad use of ~a" e)]
             [(label) (raise-compile-error s "~a is a label" e)]
             [else (raise-compile-error s "unbound identifier ~a~a" e
                                        (if (> phase 0) (format " at phase ~a" phase) ""))]))]
        [(pair? e)
         (let ([head (car e)])
           (unless (id? head)
             (raise-compile-error s "the head of a form must be an identifier, got ~s" (stx->datum head)))
           (let ([m (meaning-of head phase)])
             (case (and m (car m))
               [(core) (at s (expand-core (cadr m) s phase))]
               [(macro) (expand-expr (apply-macro head (cadr m) s phase) phase)]
               [(prim) (at s (expand-prim (cadr m) s phase))]
               [(func) (let ([args (or (stx->list (cdr e)) (raise-compile-error s "bad call syntax"))])
                         (at s (list 'call (cadr m) (map-lr (lambda (a) (expand-expr a phase)) args))))]
               [(local global) (raise-compile-error s "~a is a variable, not a function" (stx-e head))]
               [(label) (raise-compile-error s "~a is a label" (stx-e head))]
               [else (raise-compile-error head "unbound identifier ~a~a" (stx-e head)
                                          (if (> phase 0) (format " at phase ~a" phase) ""))])))]
        [(null? e) (raise-compile-error s "empty form ()")]
        [(and (integer? e) (exact? e)) (at s (list 'int e))]
        [(flonum? e) (at s (list 'float e))]
        [(string? e) (at s (list 'quote e))]
        [(char? e) (at s (list 'int (char->integer e)))]
        [(eq? e #t) (at s '(const i32 10))]
        [(eq? e #f) (at s '(const i32 0))]
        [else (raise-compile-error s "~s is not an expression (quote it?)" (stx->datum s))])))

  (define (expand-prim name s phase)
    (let* ([p (lookup-prim name)]
           [args (or (stx->list (cdr (stx-e s))) (raise-compile-error s "bad syntax"))]
           [n (length (prim-op-params p))])
      (cond [(= (length args) n)
             (list 'prim name #f (map-lr (lambda (a) (expand-expr a phase)) args))]
            [(and (eq? (prim-op-kind p) 'mem) (= (length args) (+ n 1))
                  (let ([off (stx-e (list-ref args n))]) (and (fixnum? off) (>= off 0))))
             (list 'prim name (stx-e (list-ref args n))
                   (map-lr (lambda (a) (expand-expr a phase)) (list-head args n)))]
            [else (raise-compile-error s "~a takes ~a argument~a~a, got ~a" name n (if (= n 1) "" "s")
                                       (if (eq? (prim-op-kind p) 'mem) " and an optional offset" "")
                                       (length args))])))

  (define (expand-core name s phase)
    (let ([parts (or (stx->list s) (raise-compile-error s "bad ~a syntax" name))])
      (define (arity-check ok?)
        (unless ok? (raise-compile-error s "bad ~a syntax" name)))
      (define (ex x) (expand-expr x phase))
      (case name
        [(quote)
         (arity-check (= (length parts) 2))
         (list 'quote (stx->datum (cadr parts)))]
        [(quote-syntax)
         (arity-check (= (length parts) 2))
         (list 'quote (cadr parts))]
        [(quasiquote)
         (arity-check (= (length parts) 2))
         (quasi (cadr parts) 0 phase 'quasiquote 'unquote 'unquote-splicing #f)]
        [(quasisyntax)
         (arity-check (= (length parts) 2))
         (quasi (cadr parts) 0 phase 'quasisyntax 'unsyntax 'unsyntax-splicing #t)]
        [(unquote unquote-splicing unsyntax unsyntax-splicing)
         (raise-compile-error s "~a is not inside a quasi form" name)]
        [(set!)
         (arity-check (and (= (length parts) 3) (id? (cadr parts))))
         (let ([m (meaning-of (cadr parts) phase)])
           (case (and m (car m))
             [(local) (list 'lset (cadr m) (ex (caddr parts)))]
             [(global) (list 'gset (cadr m) (ex (caddr parts)))]
             [else (raise-compile-error (cadr parts) "set!: ~a is not a variable" (stx-e (cadr parts)))]))]
        [(let let*)
         (arity-check (>= (length parts) 2))
         (let ([bs (map-lr (lambda (b)
                          (let ([bp (stx->list b)])
                            (unless (and bp (memv (length bp) '(2 3)) (id? (car bp)))
                              (raise-compile-error b "expected [name init] or [name type init]"))
                            (if (= (length bp) 2)
                                (list (car bp) #f (cadr bp))
                                (list (car bp) (parse-type (cadr bp)) (caddr bp)))))
                        (or (stx->list (cadr parts)) (raise-compile-error s "bad bindings")))]
               [body (cddr parts)])
           (if (eq? name 'let)
               (let* ([inits (map-lr (lambda (b) (ex (caddr b))) bs)]
                      [sc (new-scope!)]
                      [keys (map-lr (lambda (b) (bind-local! (add-scope (car b) sc) phase)) bs)])
                 (list 'let (map-lr (lambda (k b init) (list k (cadr b) init)) keys bs inits)
                       (expand-seq (map-lr (lambda (x) (add-scope x sc)) body) phase s)))
               ;; let*: one scope per binding
               (let loop ([bs bs] [body body] [acc '()])
                 (if (null? bs)
                     (list 'let (reverse acc) (expand-seq body phase s))
                     (let* ([b (car bs)]
                            [init (ex (caddr b))]
                            [sc (new-scope!)]
                            [key (bind-local! (add-scope (car b) sc) phase)]
                            [later (map-lr (lambda (b) (list (add-scope (car b) sc) (cadr b) (add-scope (caddr b) sc)))
                                        (cdr bs))])
                       (loop later (map-lr (lambda (x) (add-scope x sc)) body)
                             (cons (list key (cadr b) init) acc)))))))]
        [(begin) (cons 'seq (map-lr ex (cdr parts)))]
        [(if)
         (arity-check (memv (length parts) '(3 4)))
         (list 'if (ex (cadr parts)) (ex (caddr parts)) (and (= (length parts) 4) (ex (cadddr parts))))]
        [(block loop)
         (arity-check (and (>= (length parts) 2) (id? (cadr parts))))
         (let* ([sc (new-scope!)]
                [key (fresh-label! (add-scope (cadr parts) sc) phase)])
           (list name key (expand-seq (map-lr (lambda (x) (add-scope x sc)) (cddr parts)) phase s)))]
        [(br)
         (arity-check (memv (length parts) '(2 3)))
         (list 'br (label-key-of (cadr parts) phase) (and (= (length parts) 3) (ex (caddr parts))))]
        [(br-if)
         (arity-check (= (length parts) 3))
         (list 'br-if (label-key-of (cadr parts) phase) (ex (caddr parts)))]
        [(return)
         (arity-check (memv (length parts) '(1 2)))
         (list 'return (and (= (length parts) 2) (ex (cadr parts))))]
        [(call-indirect)
         (arity-check (>= (length parts) 3))
         (let-values ([(params results) (parse-signature (cadr parts))])
           (list 'call-indirect params results (ex (caddr parts)) (map-lr ex (cdddr parts))))]
        [(func-index)
         (arity-check (and (= (length parts) 2) (id? (cadr parts))))
         (let ([m (meaning-of (cadr parts) phase)])
           (unless (and m (eq? (car m) 'func))
             (raise-compile-error (cadr parts) "func-index: ~a is not a function" (stx-e (cadr parts))))
           (list 'func-index (cadr m)))]
        [(select)
         (arity-check (= (length parts) 4))
         (list 'select (ex (cadr parts)) (ex (caddr parts)) (ex (cadddr parts)))]
        [(drop)
         (arity-check (= (length parts) 2))
         (list 'drop (ex (cadr parts)))]
        [(unreachable) (arity-check (= (length parts) 1)) '(unreachable)]
        [(nop) (arity-check (= (length parts) 1)) '(nop)]
        [else (raise-compile-error s "~a is only allowed at module level" name)])))

  (define (bind-local! id phase)
    (let ([key (bind! id phase #f)])
      (hashtable-set! meanings key (list 'local key))
      key))

  (define (fresh-label! id phase)
    (let ([key (bind! id phase #f)])
      (hashtable-set! meanings key (list 'label key))
      key))

  (define (label-key-of id phase)
    (let ([m (and (id? id) (meaning-of id phase))])
      (unless (and m (eq? (car m) 'label))
        (raise-compile-error id "~s is not a label" (stx->datum id)))
      (cadr m)))

  ;; ==== quasiquote / quasisyntax =========================================================
  ;;
  ;; One walker for both. For quasisyntax, unchanged subtemplates become
  ;; syntax constants and changed lists are rewrapped with the template's
  ;; own scopes and srcloc (rt's syntax-rewrap).

  (define (quasi t depth phase qname uname sname syntax?)
    (define (tagged? x name)
      (let ([l (stx->list x)])
        (and l (= (length l) 2) (core-id? (car l) name phase))))
    (define (changes? x depth)
      (cond [(tagged? x uname) (or (= depth 0) (changes? (cadr (stx->list x)) (- depth 1)))]
            [(tagged? x sname) (or (= depth 0) (changes? (cadr (stx->list x)) (- depth 1)))]
            [(tagged? x qname) (changes? (cadr (stx->list x)) (+ depth 1))]
            [(pair? (stx-e x))
             (let loop ([e (stx-e x)])
               (cond [(null? e) #f]
                     [(stx? e) (changes? e depth)]
                     [else (or (changes? (car e) depth) (loop (cdr e)))]))]
            [(vector? (stx-e x)) (exists (lambda (y) (changes? y depth)) (vector->list (stx-e x)))]
            [else #f]))
    (define (constant x) (list 'quote (if syntax? x (stx->datum x))))
    ;; Rebuild the pair chain e (elements of template x) as an expression.
    (define (build-list x e depth)
      (let loop ([e e])
        (cond [(null? e) '(quote ())]
              [(stx? e) (walk e depth)]
              [(and (= depth 0) (tagged? (car e) sname))
               (let ([v (expand-expr (cadr (stx->list (car e))) phase)])
                 (rt-call 'append (if syntax? (rt-call 'splice-list v) v) (loop (cdr e))))]
              [else (rt-call 'cons (walk (car e) depth) (loop (cdr e)))])))
    (define (walk x depth)
      (cond [(not (changes? x depth)) (constant x)]
            [(and (tagged? x uname) (= depth 0)) (expand-expr (cadr (stx->list x)) phase)]
            [(pair? (stx-e x))
             (let* ([l (stx-e x)]
                    [inner-depth (cond [(or (tagged? x uname) (tagged? x sname)) (- depth 1)]
                                       [(tagged? x qname) (+ depth 1)]
                                       [else depth])]
                    [head (if (or (tagged? x uname) (tagged? x sname) (tagged? x qname))
                              (rt-call 'cons (constant (car l)) (build-list x (cdr l) inner-depth))
                              (build-list x l depth))])
               (if syntax? (rt-call 'syntax-rewrap (constant x) head) head))]
            [(vector? (stx-e x))
             (let ([items (build-list x (vector->list (stx-e x)) depth)])
               (if syntax?
                   (rt-call 'syntax-rewrap (constant x) (rt-call 'list->vector items))
                   (rt-call 'list->vector items)))]
            [else (constant x)]))
    (walk t depth))

  ;; ==== debugging output ===================================================================

  ;; Fully expanded forms with info records and srclocs replaced by names,
  ;; for `subc expand`.
  (define (strip-ast x)
    (cond [(func-info? x) (func-info-name x)]
          [(global-info? x) (global-info-name x)]
          [(stx? x) (list 'syntax (stx->datum x))]
          [(and (pair? x) (eq? (car x) 'at)) (strip-ast (caddr x))]
          [(pair? x) (cons (strip-ast (car x)) (strip-ast (cdr x)))]
          [else x])))
