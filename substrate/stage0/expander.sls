;; Expander: syntax objects -> fully expanded kernel forms (core.sls).
;;
;; Binding is by sets of scopes (spec 6.1). Phase >= 1 code is compiled
;; into chunks and run in the compile-time store as expansion goes
;; (spec 3.1). A macro is a phase-1 function from syntax to syntax
;; (spec 2.1). Syntax objects are GC objects of the syntax library
;; (stage0/syntax.sub), which every compile-time store instantiates.
(library (stage0 expander)
  (export make-session session-library-bytes session-store compile-source expand-source
          strip-ast)
  (import (chezscheme) (stage0 syntax) (stage0 core) (stage0 ops) (stage0 compile)
          (stage0 host) (stage0 marshal) (stage0 reader))

  ;; ==== sessions ==============================================================
  ;;
  ;; A session is one compile-time store with the syntax library
  ;; instantiated in it, plus the library's functions by name.

  (define-record-type (session new-session session?) (fields store library-bytes infos))

  (define gc-forms
    '(struct.new struct.get struct.get_s struct.get_u struct.set
      array.new array.new_default array.new_fixed array.get array.get_s array.get_u array.set
      array.len array.copy array.fill
      ref.null ref.is_null ref.eq ref.as_non_null ref.test ref.cast ref.i31 i31.get_s i31.get_u))

  (define core-forms
    (append
     '(func global import memory table data type define-syntax define-static begin-for-syntax
       begin include require runtime-free set! let let* if block loop br br-if return
       call-indirect func-index data-address data-size select drop unreachable nop
       quote quasiquote unquote unquote-splicing quote-syntax quasisyntax unsyntax unsyntax-splicing)
     gc-forms))

  (define eqref (make-ref #t 'eq))

  ;; library-path: the kernel source of the syntax library. Compiles it,
  ;; starts a compile-time store and instantiates the library there.
  (define (make-session library-path)
    (let* ([h (host-new)]
           [st (make-store h)])
      (host-set-callback! h expander-callback)
      (let-values ([(forms infos) (parameterize ([current-syntax-infos #f])
                                    (expand-module (read-file library-path) 'syntax st))])
        (let-values ([(bytes imports gc?) (parameterize ([current-syntax-infos #f])
                                            (compile-module forms "syntax"))])
          (let ([table (make-eq-hashtable)])
            (for-each (lambda (info) (hashtable-set! table (func-info-name info) info)) infos)
            (host-instantiate! h "syntax" bytes)
            (new-session st bytes table))))))

  ;; Expand and compile one source file. Returns the phase-0 module bytes and
  ;; the instance names it imports from.
  (define (compile-source sess path)
    (parameterize ([current-syntax-infos (session-infos sess)])
      (let-values ([(forms _) (expand-module (read-file path) (module-name path) (session-store sess))])
        (let-values ([(bytes imports gc?) (compile-module forms "main")])
          (when runtime-free-form
            (let ([extra (filter (lambda (i) (not (equal? i "host"))) imports)])
              (unless (and (null? extra) (not gc?))
                (raise-compile-error runtime-free-form
                                     "this module is declared runtime-free, but after expansion it ~a"
                                     (cond [(pair? extra) (format "imports from ~a" extra)]
                                           [else "uses GC objects"])))))
          (values bytes imports)))))

  (define (expand-source sess path)
    (parameterize ([current-syntax-infos (session-infos sess)])
      (let-values ([(forms _) (expand-module (read-file path) (module-name path) (session-store sess))])
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
  (define syntax-phases '())               ; phases where (require syntax) appeared
  (define runtime-free-form #f)            ; the (runtime-free) form, if any

  ;; phase: an integer, or 'all
  (define-record-type binding (fields scopes phase key))

  ;; meaning: (core name) (prim name) (func info) (global info) (data info)
  ;;          (type info) (local key) (label key) (macro chunk) (static handle)

  (define (reset-state! module st)
    (set! bindings (make-eq-hashtable))
    (set! meanings (make-eqv-hashtable))
    (set! scope-counter 0)
    (set! chunk-counter 0)
    (set! current-module module)
    (set! current-store st)
    (set! syntax-phases '())
    (set! runtime-free-form #f)
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
      (or (eq? p 'all) (eqv? p phase))))

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

  (define (internal-name? sym) (char=? (string-ref (symbol->string sym) 0) #\%))

  ;; Core forms and primitive operators, at every phase (spec 5.5). Nothing
  ;; else is bound until a module requires it.
  (define (install-base!)
    (for-each (lambda (name) (bind-raw! name (list core-scope) 'all (list 'core name))) core-forms)
    (for-each (lambda (name) (bind-raw! name (list core-scope) 'all (list 'prim name))) (prim-names)))

  ;; ==== module bodies ============================================================

  ;; Expand a module. Returns (values phase-0-forms defined-func-infos).
  (define (expand-module forms module st)
    (reset-state! module st)
    (install-base!)
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
              [(include) (loop (append (read-include f) rest) pending)]
              [(require) (require! f phase) (loop rest pending)]
              [(runtime-free) (runtime-free! f phase) (loop rest pending)]
              [(func) (loop rest (cons (declare-func f phase) pending))]
              [(global) (loop rest (cons (declare-global f phase) pending))]
              [(import) (declare-import f phase) (loop rest pending)]
              [(memory table) (loop rest (cons (list 'plain (parse-size f)) pending))]
              [(data) (loop rest (cons (list 'plain (declare-data f phase)) pending))]
              [(type) (loop rest (cons (list 'plain (declare-type f phase)) pending))]
              [(define-syntax) (define-syntax! f phase) (loop rest pending)]
              [(define-static) (define-static! f phase) (loop rest pending)]
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

  ;; ==== types ====================================================================

  (define shorthand-refs
    '((anyref . any) (eqref . eq) (i31ref . i31) (structref . struct) (arrayref . array)
      (funcref . func) (externref . extern)))

  ;; A heap type: an abstract name, or a type declared with `type`.
  (define (parse-heap s phase)
    (cond [(and (id? s) (memq (stx-e s) abstract-heaps)) (stx-e s)]
          [(id? s)
           (let ([m (meaning-of s phase)])
             (unless (and m (eq? (car m) 'type))
               (raise-compile-error s "~a is not a type" (stx-e s)))
             (cadr m))]
          [else (raise-compile-error s "expected a heap type, got ~s" (stx->datum s))]))

  (define (parse-type s phase)
    (let ([d (stx-e s)])
      (cond [(and (symbol? d) (memq d '(i32 i64 f32 f64))) d]
            [(and (symbol? d) (assq d shorthand-refs)) => (lambda (p) (make-ref #t (cdr p)))]
            [(and (stx->list s) (pair? (stx->list s)) (core-name? (car (stx->list s)) 'ref))
             (let ([parts (stx->list s)])
               (cond [(= (length parts) 2) (make-ref #f (parse-heap (cadr parts) phase))]
                     [(and (= (length parts) 3) (id? (cadr parts)) (eq? (stx-e (cadr parts)) 'null))
                      (make-ref #t (parse-heap (caddr parts) phase))]
                     [else (raise-compile-error s "expected (ref T) or (ref null T)")]))]
            [else (raise-compile-error s "expected a type (i32, i64, f32, f64 or a reference type), got ~s"
                                       (stx->datum s))])))

  (define (parse-reftype s phase)
    (let ([t (parse-type s phase)])
      (unless (ref-type? t) (raise-compile-error s "expected a reference type"))
      t))

  ;; Type syntax words (ref, null, field, mut, struct, array) are compared by
  ;; name, like i32.
  (define (core-name? s name) (and (id? s) (eq? (stx-e s) name)))

  ;; A field or element type: a storage type, optionally (mut storage).
  (define (parse-field-type s phase)
    (let ([parts (stx->list s)])
      (if (and parts (= (length parts) 2) (core-name? (car parts) 'mut))
          (list (parse-storage (cadr parts) phase) #t)
          (list (parse-storage s phase) #f))))

  (define (parse-storage s phase)
    (if (and (id? s) (memq (stx-e s) '(i8 i16))) (stx-e s) (parse-type s phase)))

  ;; (type name (struct (field fname ftype) ...)) or (type name (array etype)).
  ;; The name is bound first, so a type may refer to itself.
  (define (declare-type f phase)
    (let ([parts (stx-list-of f 'type)])
      (unless (and (= (length parts) 3) (id? (cadr parts)) (stx->list (caddr parts))
                   (pair? (stx->list (caddr parts))))
        (raise-compile-error f "expected (type name (struct field ...)) or (type name (array type))"))
      (when (memq (stx-e (cadr parts)) (append abstract-heaps '(i32 i64 f32 f64 i8 i16)))
        (raise-compile-error (cadr parts) "~a names a built-in type" (stx-e (cadr parts))))
      (let* ([def (stx->list (caddr parts))]
             [kind (stx-e (car def))])
        (unless (memq kind '(struct array))
          (raise-compile-error (caddr parts) "a type is (struct field ...) or (array type)"))
        (let ([info (make-type-info (stx-e (cadr parts)) kind #f)])
          (bind! (cadr parts) phase (list 'type info))
          (type-info-fields-set!
           info
           (if (eq? kind 'struct)
               (map-lr (lambda (fs)
                         (let ([fp (stx->list fs)])
                           (unless (and fp (= (length fp) 3) (core-name? (car fp) 'field) (id? (cadr fp)))
                             (raise-compile-error fs "expected (field name type)"))
                           (cons (stx-e (cadr fp)) (parse-field-type (caddr fp) phase))))
                       (cdr def))
               (begin
                 (unless (= (length def) 2) (raise-compile-error (caddr parts) "expected (array type)"))
                 (parse-field-type (cadr def) phase))))
          (list 'type info)))))

  (define (type-of id phase)
    (let ([m (and (id? id) (meaning-of id phase))])
      (unless (and m (eq? (car m) 'type))
        (raise-compile-error id "~s is not a declared type" (stx->datum id)))
      (cadr m)))

  (define (field-index tinfo id)
    (unless (eq? (type-info-kind tinfo) 'struct)
      (raise-compile-error id "~a is not a struct type" (type-info-name tinfo)))
    (let loop ([fs (type-info-fields tinfo)] [i 0])
      (cond [(null? fs) (raise-compile-error id "~a has no field ~s" (type-info-name tinfo) (stx->datum id))]
            [(and (id? id) (eq? (car (car fs)) (stx-e id))) i]
            [else (loop (cdr fs) (+ i 1))])))

  ;; ==== other module-level forms ==================================================

  ;; `-> t` or `-> (t ...)`; returns the result list and the rest of body.
  (define (parse-results body phase)
    (if (and (pair? body) (id? (car body)) (eq? (stx-e (car body)) '->))
        (begin
          (when (null? (cdr body)) (raise-compile-error (car body) "expected a type after ->"))
          (let* ([r (cadr body)] [l (stx->list r)])
            (values (if (and l (not (core-name? (car l) 'ref)))
                        (map-lr (lambda (t) (parse-type t phase)) l)
                        (list (parse-type r phase)))
                    (cddr body))))
        (values '() body)))

  ;; (t ... -> r ...)
  (define (parse-signature s phase)
    (let* ([parts (stx-list-of s "signature")]
           [arrow (let loop ([ps parts] [i 0])
                    (cond [(null? ps) (raise-compile-error s "a signature needs ->")]
                          [(and (id? (car ps)) (eq? (stx-e (car ps)) '->)) i]
                          [else (loop (cdr ps) (+ i 1))]))])
      (values (map-lr (lambda (t) (parse-type t phase)) (list-head parts arrow))
              (map-lr (lambda (t) (parse-type t phase)) (list-tail parts (+ arrow 1))))))

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
                                 (cons (car pp) (parse-type (cadr pp) phase))))
                             (cdr hparts))])
        (let-values ([(results body) (parse-results (cddr parts) phase)])
          (let ([info (make-func-info (stx-e name) (map cdr params) results #f #f)])
            (bind! name phase (list 'func info))
            (list 'func info params body f))))))

  (define (expand-func p phase)
    (let* ([info (list-ref p 1)] [params (list-ref p 2)] [body (list-ref p 3)] [f (list-ref p 4)]
           [sc (new-scope!)]
           [keys (map-lr (lambda (pr) (bind-local! (add-scope (car pr) sc) phase)) params)])
      (list 'func info (map-lr (lambda (k pr) (cons k (cdr pr))) keys params)
            (expand-seq (map-lr (lambda (b) (add-scope b sc)) body) phase f))))

  ;; (global name type init)
  (define (declare-global f phase)
    (let ([parts (stx-list-of f 'global)])
      (unless (and (= (length parts) 4) (id? (cadr parts)))
        (raise-compile-error f "expected (global name type init)"))
      (let ([info (make-global-info (stx-e (cadr parts)) (parse-type (caddr parts) phase) #f #f)])
        (bind! (cadr parts) phase (list 'global info))
        (list 'global info (cadddr parts)))))

  ;; (import name "module" "field" (t ... -> r ...))
  (define (declare-import f phase)
    (let ([parts (stx-list-of f 'import)])
      (unless (and (= (length parts) 5) (id? (cadr parts))
                   (string? (stx-e (caddr parts))) (string? (stx-e (cadddr parts))))
        (raise-compile-error f "expected (import name \"module\" \"field\" (type ... -> type ...))"))
      (let-values ([(params results) (parse-signature (list-ref parts 4) phase)])
        (bind! (cadr parts) phase
               (list 'func (make-func-info (stx-e (cadr parts)) params results
                                           (stx-e (caddr parts)) (stx-e (cadddr parts))))))))

  ;; (memory pages) / (table size)
  (define (parse-size f)
    (let ([parts (stx-list-of f 'memory)])
      (unless (and (= (length parts) 2) (fixnum? (stx-e (cadr parts))) (>= (stx-e (cadr parts)) 0))
        (raise-compile-error f "expected (~a size)" (stx-e (car parts))))
      (list (stx-e (car parts)) (stx-e (cadr parts)))))

  ;; (data name offset "bytes" ...): an active segment in the module's memory.
  (define (declare-data f phase)
    (let ([parts (stx-list-of f 'data)])
      (unless (and (>= (length parts) 3) (id? (cadr parts))
                   (fixnum? (stx-e (caddr parts))) (>= (stx-e (caddr parts)) 0)
                   (for-all (lambda (s) (string? (stx-e s))) (cdddr parts)))
        (raise-compile-error f "expected (data name offset \"bytes\" ...)"))
      (let ([info (make-data-info (stx-e (cadr parts)) (stx-e (caddr parts))
                                  (string->utf8 (apply string-append (map stx-e (cdddr parts)))))])
        (bind! (cadr parts) phase (list 'data info))
        (list 'data info))))

  ;; (require syntax): bind the syntax library's contract functions at this
  ;; phase (spec 2.3). The only library v0 knows; modules generalize it.
  (define (require! f phase)
    (let ([parts (stx-list-of f 'require)])
      (unless (and (= (length parts) 2) (core-name? (cadr parts) 'syntax))
        (raise-compile-error f "v0 can only (require syntax)"))
      (unless (current-syntax-infos)
        (raise-compile-error f "the syntax library cannot require itself"))
      (unless (memv phase syntax-phases)
        (set! syntax-phases (cons phase syntax-phases))
        (let-values ([(names infos) (hashtable-entries (current-syntax-infos))])
          ;; sorted, for deterministic keys
          (for-each (lambda (info) (bind-raw! (func-info-name info) (stx-scopes (car parts)) phase (list 'func info)))
                    (list-sort (lambda (a b) (string<? (symbol->string (func-info-name a))
                                                        (symbol->string (func-info-name b))))
                               (filter (lambda (info) (not (internal-name? (func-info-name info))))
                                       (vector->list infos))))))))

  (define (require-syntax-for s name phase)
    (unless (memv phase syntax-phases)
      (raise-compile-error s "~a builds syntax-library data: add (require syntax)~a" name
                           (if (> phase 0) (format " at phase ~a" phase) ""))))

  ;; (runtime-free): after expansion, the phase-0 module may import only from
  ;; the host and may not use GC objects (spec 3.2).
  (define (runtime-free! f phase)
    (unless (and (= phase 0) (equal? (map stx-e (stx-list-of f 'runtime-free)) '(runtime-free)))
      (raise-compile-error f "(runtime-free) takes nothing and belongs at phase 0"))
    (set! runtime-free-form f))

  ;; (include "path"): the forms of another file, spliced in place, with the
  ;; include form's scopes. The path is relative to the including file.
  ;; Temporary: modules replace it (spec section 7).
  (define (read-include f)
    (let ([parts (stx-list-of f 'include)])
      (unless (and (= (length parts) 2) (string? (stx-e (cadr parts))))
        (raise-compile-error f "expected (include \"path\")"))
      (let* ([loc (stx-srcloc f)]
             [dir (if loc (directory-of (symbol->string (srcloc-source loc))) "")]
             [path (string-append dir (stx-e (cadr parts)))]
             [scopes (stx-scopes (car parts))])
        (unless (file-exists? path) (raise-compile-error f "include: no file ~a" path))
        (map-lr (lambda (form) (fold-left add-scope form scopes)) (read-file path)))))

  (define (directory-of path)
    (let loop ([i (- (string-length path) 1)])
      (cond [(< i 0) ""]
            [(char=? (string-ref path i) #\/) (substring path 0 (+ i 1))]
            [else (loop (- i 1))])))

  ;; ==== compile-time evaluation ===================================================

  (define (next-chunk-name! phase)
    (let ([n chunk-counter])
      (set! chunk-counter (+ n 1))
      (format "~a@~a#~a" current-module phase n)))

  (define (run-chunk! forms phase where)
    (let ([name (next-chunk-name! phase)])
      (let-values ([(bytes imports gc?) (compile-module forms name)])
        (guard (c [(wasm-failure? c)
                   (raise-compile-error where "compile-time code failed: ~a" (wasm-failure-message c))])
          (flush-output-port (current-output-port))
          (host-instantiate! (store-host current-store) name bytes))
        name)))

  (define (syntax-info name)
    (or (hashtable-ref (current-syntax-infos) name #f)
        (raise-compile-error #f "internal: the syntax library has no ~a" name)))

  ;; A one-function chunk that gives Chez an i32 entry point: it turns
  ;; handles into references around `body`, which returns an eqref.
  (define (handle-chunk! param? body phase where)
    (let* ([key (and param? (fresh-key!))]
           [wrapper (make-func-info '__entry (if param? '(i32) '()) '(i32) #f #f)]
           [body (body (and param? (list 'call (syntax-info '%deref) (list (list 'lref key)))))]
           [chunk (run-chunk! (list (list 'func wrapper (if param? (list (cons key 'i32)) '())
                                          (list 'call (syntax-info '%handle) (list body))))
                              phase where)])
      chunk))

  ;; (define-syntax name f): name is a macro whose transformer is the phase+1
  ;; function f, of type (eqref) -> eqref, from an earlier begin-for-syntax.
  (define (define-syntax! f phase)
    (let ([parts (stx-list-of f 'define-syntax)])
      (unless (and (= (length parts) 3) (id? (cadr parts)) (id? (caddr parts)))
        (raise-compile-error f "expected (define-syntax name transformer-function)"))
      (let ([m (meaning-of (caddr parts) (+ phase 1))])
        (unless (and m (eq? (car m) 'func))
          (raise-compile-error (caddr parts) "~a is not a function at phase ~a"
                               (stx-e (caddr parts)) (+ phase 1)))
        (let ([info (cadr m)])
          (unless (and (equal? (func-info-params info) (list eqref))
                       (types<=? (func-info-results info) (list eqref)))
            (raise-compile-error (caddr parts) "a transformer takes one eqref (syntax) and returns one eqref"))
          (unless (func-info-instance info)
            (raise-compile-error (caddr parts) "~a must be defined by an earlier begin-for-syntax"
                                 (stx-e (caddr parts))))
          (let ([chunk (handle-chunk! #t (lambda (arg) (list 'call info (list arg))) (+ phase 1) f)])
            (bind! (cadr parts) phase (list 'macro chunk)))))))

  ;; (define-static name expr): name is bound to the value of expr, computed
  ;; now at phase+1. Macros read it with syntax-local-value.
  (define (define-static! f phase)
    (let ([parts (stx-list-of f 'define-static)])
      (unless (and (= (length parts) 3) (id? (cadr parts)))
        (raise-compile-error f "expected (define-static name expr)"))
      (let* ([rhs (expand-expr (caddr parts) (+ phase 1))]
             [chunk (handle-chunk! #f (lambda (_) rhs) (+ phase 1) f)]
             [handle (call-in-store f (lambda (h) (host-call h chunk "__entry")))])
        (bind! (cadr parts) phase (list 'static handle)))))

  ;; (begin-for-syntax form ...)
  (define (begin-for-syntax! f phase)
    (let ([forms (expand-body (cdr (stx-list-of f 'begin-for-syntax)) (+ phase 1))])
      (run-chunk! forms (+ phase 1) f)))

  ;; ==== macros ======================================================================

  ;; State the expander query callbacks read.
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

  (define (apply-macro head chunk s phase)
    (let ([saved-phase api-phase] [saved-where api-where])
      (dynamic-wind
        (lambda () (set! api-phase phase) (set! api-where s))
        (lambda ()
          (let* ([mark (handle-mark current-store)]
                 [in (encode current-store s)]
                 [out (call-in-store s (lambda (h) (host-call h chunk "__entry" in)))]
                 [result (decode current-store out)])
            (handle-release! current-store mark)
            (unless (stx? result)
              (raise-compile-error s "macro ~a returned a non-syntax value: ~s" (stx-e head)
                                   (if (wasm-value? result) '<object> (stx->datum result))))
            result))
        (lambda () (set! api-phase saved-phase) (set! api-where saved-where)))))

  ;; Entry point for wasm calls to the expander queries. Arguments and results
  ;; are handles. Must never raise: an exception here would unwind through C
  ;; and wasm frames.
  (define (expander-callback op a b)
    (guard (c [#t (set! api-error
                        (if (compile-error? c)
                            c
                            (condition (make-error) (make-message-condition
                                                     (if (message-condition? c)
                                                         (condition-message c)
                                                         (format "~s" c))))))
                  (host-request-trap! (store-host current-store) "expander query failed")
                  0])
      (case op
        [(1)                            ; syntax-local-value
         (let ([id (decode current-store a)])
           (let ([m (and (id? id) (meaning-of id api-phase))])
             (if (and m (eq? (car m) 'static)) (cadr m) 0)))]
        [(2)                            ; syntax-error
         (let ([s (decode current-store a)] [msg (decode current-store b)])
           (raise-compile-error (if (and (stx? s) (stx-srcloc s)) s api-where) "~a~a"
                                (if (string? msg) msg (format "~s" msg))
                                (if (stx? s) (format "\n  in: ~s" (stx->datum s)) "")))]
        [(3)                            ; free-identifier=?
         (let ([x (decode current-store a)] [y (decode current-store b)])
           (unless (and (id? x) (id? y)) (raise-compile-error api-where "free-identifier=?: expected identifiers"))
           (let ([kx (resolve x api-phase)] [ky (resolve y api-phase)])
             (if (if (or kx ky) (eqv? kx ky) (eq? (stx-e x) (stx-e y))) 1 0)))]
        [else (raise-compile-error api-where "unknown expander query ~a" op)])))

  ;; ==== expressions ===================================================================

  (define (at s ast) (list 'at (stx-srcloc s) ast))

  (define (expand-seq forms phase where)
    (if (null? forms)
        (at where '(seq))
        (at where (cons 'seq (map-lr (lambda (f) (expand-expr f phase)) forms)))))

  ;; A call to one of the syntax library's functions, for forms that build
  ;; its data (quasiquote, quasisyntax).
  (define (syntax-call name . args) (list 'call (syntax-info name) args))

  (define (unbound s sym phase)
    (raise-compile-error s "unbound identifier ~a~a" sym (if (> phase 0) (format " at phase ~a" phase) "")))

  (define (expand-expr s phase)
    (let ([e (stx-e s)])
      (cond
        [(symbol? e)
         (let ([m (meaning-of s phase)])
           (case (and m (car m))
             [(local) (at s (list 'lref (cadr m)))]
             [(global) (at s (list 'gref (cadr m)))]
             [(macro) (expand-expr (apply-macro s (cadr m) s phase) phase)]
             [(static) (raise-compile-error s "~a is static information: read it with syntax-local-value" e)]
             [(func) (raise-compile-error s "~a is a function: call it, or use (func-index ~a)" e e)]
             [(data) (raise-compile-error s "~a is data: use (data-address ~a) and (data-size ~a)" e e e)]
             [(type) (raise-compile-error s "~a is a type" e)]
             [(core prim) (raise-compile-error s "bad use of ~a" e)]
             [(label) (raise-compile-error s "~a is a label" e)]
             [else (unbound s e phase)]))]
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
               [(static data label type) (raise-compile-error s "~a is not a function or a macro" (stx-e head))]
               [else (unbound head (stx-e head) phase)])))]
        [(null? e) (raise-compile-error s "empty form ()")]
        ;; Unquoted literals are wasm numbers (spec 5.4).
        [(and (integer? e) (exact? e)) (at s (list 'int e))]
        [(flonum? e) (at s (list 'float e))]
        [(char? e) (at s (list 'int (char->integer e)))]
        [(eq? e #t) (at s '(const i32 1))]
        [(eq? e #f) (at s '(const i32 0))]
        [(string? e)
         (raise-compile-error s "a string is not a wasm value: use (data name offset \"...\") for bytes, or '\"...\" for a syntax-library string")]
        [else (raise-compile-error s "~s is not an expression" (stx->datum s))])))

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

  (define (data-info-of id phase)
    (let ([m (and (id? id) (meaning-of id phase))])
      (unless (and m (eq? (car m) 'data))
        (raise-compile-error id "~s is not data" (stx->datum id)))
      (cadr m)))

  ;; GC forms: (op immediate ... arg ...). Immediates are types, fields and
  ;; reference types, resolved here.
  (define (expand-gc name parts phase)
    (define (ex x) (expand-expr x phase))
    (define (arity n) (unless (= (length parts) n) (raise-compile-error (car parts) "bad ~a syntax" name)))
    (define args (cdr parts))
    (case name
      [(struct.new array.new_fixed)
       (unless (>= (length args) 1) (raise-compile-error (car parts) "bad ~a syntax" name))
       (let ([t (type-of (car args) phase)])
         (unless (eq? (type-info-kind t) (if (eq? name 'struct.new) 'struct 'array))
           (raise-compile-error (car args) "~a is not a~a type" (type-info-name t)
                                (if (eq? name 'struct.new) " struct" "n array")))
         (list 'gc name (list t) (map-lr ex (cdr args))))]
      [(struct.get struct.get_s struct.get_u)
       (arity 4)
       (let ([t (type-of (car args) phase)])
         (list 'gc name (list t (field-index t (cadr args))) (list (ex (caddr args)))))]
      [(struct.set)
       (arity 5)
       (let ([t (type-of (car args) phase)])
         (list 'gc name (list t (field-index t (cadr args))) (list (ex (caddr args)) (ex (cadddr args)))))]
      [(array.new array.new_default array.get array.get_s array.get_u array.set array.fill)
       (arity (+ 2 (case name [(array.new_default) 1] [(array.new array.get array.get_s array.get_u) 2]
                     [(array.set) 3] [(array.fill) 4])))
       (let ([t (type-of (car args) phase)])
         (unless (eq? (type-info-kind t) 'array)
           (raise-compile-error (car args) "~a is not an array type" (type-info-name t)))
         (list 'gc name (list t) (map-lr ex (cdr args))))]
      [(array.copy)
       (arity 8)
       (list 'gc name (list (type-of (car args) phase) (type-of (cadr args) phase)) (map-lr ex (cddr args)))]
      [(ref.null)
       (arity 2)
       (list 'gc name (list (parse-heap (car args) phase)) '())]
      [(ref.test ref.cast)
       (arity 3)
       (list 'gc name (list (parse-reftype (car args) phase)) (list (ex (cadr args))))]
      [(ref.eq) (arity 3) (list 'gc name '() (map-lr ex args))]
      [(array.len ref.is_null ref.as_non_null ref.i31 i31.get_s i31.get_u)
       (arity 2)
       (list 'gc name '() (list (ex (car args))))]
      [else (raise-compile-error (car parts) "internal: unknown GC form ~a" name)]))

  (define (expand-core name s phase)
    (let ([parts (or (stx->list s) (raise-compile-error s "bad ~a syntax" name))])
      (define (arity-check ok?)
        (unless ok? (raise-compile-error s "bad ~a syntax" name)))
      (define (ex x) (expand-expr x phase))
      (case name
        [(quote)
         (arity-check (= (length parts) 2))
         (require-syntax-for s name phase)
         (list 'quote (stx->datum (cadr parts)))]
        [(quote-syntax)
         (arity-check (= (length parts) 2))
         (require-syntax-for s name phase)
         (list 'quote (cadr parts))]
        [(quasiquote)
         (arity-check (= (length parts) 2))
         (require-syntax-for s name phase)
         (quasi (cadr parts) 0 phase 'quasiquote 'unquote 'unquote-splicing #f)]
        [(quasisyntax)
         (arity-check (= (length parts) 2))
         (require-syntax-for s name phase)
         (quasi (cadr parts) 0 phase 'quasisyntax 'unsyntax 'unsyntax-splicing #t)]
        [(unquote unquote-splicing unsyntax unsyntax-splicing)
         (raise-compile-error s "~a is not inside a quasi form" name)]
        [(data-address)
         (arity-check (= (length parts) 2))
         (list 'const 'i32 (data-info-offset (data-info-of (cadr parts) phase)))]
        [(data-size)
         (arity-check (= (length parts) 2))
         (list 'const 'i32 (bytevector-length (data-info-bytes (data-info-of (cadr parts) phase))))]
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
                                   (list (car bp) (parse-type (cadr bp) phase) (caddr bp)))))
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
         (let-values ([(params results) (parse-signature (cadr parts) phase)])
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
        [else
         (if (memq name gc-forms)
             (expand-gc name parts phase)
             (raise-compile-error s "~a is only allowed at module level" name))])))

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
  ;; own scopes and srcloc (syntax-rewrap).

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
            [else #f]))
    (define (constant x) (list 'quote (if syntax? x (stx->datum x))))
    ;; Rebuild the pair chain e (elements of template x) as an expression.
    (define (build-list x e depth)
      (let loop ([e e])
        (cond [(null? e) '(quote ())]
              [(stx? e) (walk e depth)]
              [(and (= depth 0) (tagged? (car e) sname))
               (let ([v (expand-expr (cadr (stx->list (car e))) phase)])
                 (syntax-call 'append (if syntax? (syntax-call 'splice-list v) v) (loop (cdr e))))]
              [else (syntax-call 'cons (walk (car e) depth) (loop (cdr e)))])))
    (define (walk x depth)
      (cond [(not (changes? x depth)) (constant x)]
            [(and (tagged? x uname) (= depth 0)) (expand-expr (cadr (stx->list x)) phase)]
            [(pair? (stx-e x))
             (let* ([l (stx-e x)]
                    [inner-depth (cond [(or (tagged? x uname) (tagged? x sname)) (- depth 1)]
                                       [(tagged? x qname) (+ depth 1)]
                                       [else depth])]
                    [head (if (or (tagged? x uname) (tagged? x sname) (tagged? x qname))
                              (syntax-call 'cons (constant (car l)) (build-list x (cdr l) inner-depth))
                              (build-list x l depth))])
               (if syntax? (syntax-call 'syntax-rewrap (constant x) head) head))]
            [else (constant x)]))
    (walk t depth))

  ;; ==== debugging output ===================================================================

  ;; Fully expanded forms with info records and srclocs replaced by names,
  ;; for `subc expand`.
  (define (strip-ast x)
    (cond [(func-info? x) (func-info-name x)]
          [(global-info? x) (global-info-name x)]
          [(data-info? x) (data-info-name x)]
          [(type-info? x) (type-info-name x)]
          [(stx? x) (list 'syntax (stx->datum x))]
          [(and (pair? x) (eq? (car x) 'at)) (strip-ast (caddr x))]
          [(pair? x) (cons (strip-ast (car x)) (strip-ast (cdr x)))]
          [else x])))
