;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Expander: syntax objects -> expanded code, which is syntax too (spec
;; 6.4) -> after the module passes (spec 6.5), lowered to the compiler's
;; input (core.sls).
;;
;; Binding is by sets of scopes (spec 6.1). A module is a file; each of its
;; phases compiles to one wasm module, a part (spec 3.1). While a module is
;; expanded, its phase >= 1 code is compiled into chunks and run in that
;; module's compile-time store. A macro is a phase-1 function from syntax to
;; syntax (spec 2.1). Syntax objects are GC objects of the syntax library
;; (compiler/syntax.sub), which every compile-time store instantiates.
(library (stage0 expander)
  (export set-syntax-library-path! compile-module-file run-module module-part-list module-expanded-forms
          syntax-library-bytes)
  (import (chezscheme) (stage0 syntax) (stage0 core) (stage0 ops) (stage0 compile)
          (stage0 host) (stage0 marshal) (stage0 reader))

  (define gc-forms
    '(struct.new struct.get struct.get_s struct.get_u struct.set
      array.new array.new_default array.new_fixed array.get array.get_s array.get_u array.set
      array.len array.copy array.fill
      ref.null ref.is_null ref.eq ref.as_non_null ref.test ref.cast ref.i31 i31.get_s i31.get_u))

  ;; The implicit forms (spec 5.3, 5.4). Chez reads #%name as a primitive
  ;; reference, so these are built from strings.
  (define app-sym (string->symbol "#%app"))
  (define datum-sym (string->symbol "#%datum"))

  (define core-forms
    (append
     '(func global import memory table data type define-syntax define-static begin-for-syntax
       begin require provide runtime-free module-pass set! let let* if block loop br br-if return
       call-indirect func-index data-address data-size select drop unreachable nop
       quote quasiquote unquote unquote-splicing quote-syntax quasisyntax unsyntax unsyntax-splicing)
     (list app-sym datum-sym)
     gc-forms))

  (define eqref (make-ref #t 'eq))

  ;; ==== the run ===================================================================
  ;;
  ;; Everything below is shared by all modules compiled in one run of the
  ;; compiler: the binding table, scope ids, and compiled modules. A macro's
  ;; template identifiers keep resolving to its own module's bindings when
  ;; another module expands it, because those bindings stay in the table.

  (define bindings (make-eq-hashtable))    ; symbol -> list of binding
  (define meanings (make-eqv-hashtable))   ; key -> meaning
  (define scope-counter 0)
  (define base-installed? #f)
  (define registry (make-hashtable string-hash string=?))        ; absolute path -> module
  (define modules-by-name (make-hashtable string-hash string=?)) ; instance name stem -> module
  (define installed (make-hashtable string-hash string=?))       ; "path|shift" -> #t

  ;; phase: an integer, or 'all. namespace: type or value (spec 6.1).
  (define-record-type binding (fields scopes phase namespace key))

  ;; meaning: (core name) (prim name) (func info) (global info) (data info)
  ;;          (type info) (local key) (label key) (macro transformer-info)
  ;;          (static getter-info)
  ;; A type meaning is in the type namespace, every other one in the value
  ;; namespace. Locals and labels are bound before their meaning is set, so
  ;; #f counts as a value.
  (define (meaning-namespace meaning)
    (if (and meaning (eq? (car meaning) 'type)) 'type 'value))

  ;; A compiled (or compiling) module. parts: phase -> part. requires: list
  ;; of (module . shift). provides: list of (symbol . meaning). entries: its
  ;; module-level bindings, as (symbol scopes phase key). scope: its module
  ;; scope.
  (define-record-type unit
    (fields path source name (mutable state) parts (mutable requires) (mutable provides)
            (mutable entries) (mutable expanded) (mutable scope)))

  ;; One phase of a module, compiled: bytes, the instance names it imports
  ;; from (relative to the module at shift 0), whether it uses GC, and the
  ;; module scopes in its syntax literals (spec 6.1).
  (define-record-type part (fields bytes imports gc? scopes))

  ;; One wasm store: a compile-time store (one per module compilation) or a
  ;; run-time store. instances: names instantiated in it. wrappers and
  ;; statics: per-store entry chunks and static-value handles.
  (define-record-type cstore
    (fields host marshal instances wrappers statics (mutable counter)))

  ;; The state of one module's compilation.
  (define-record-type comp
    (fields module store (mutable chunk-counter) (mutable use-site-scopes)
            (mutable runtime-free-form) phase-forms memories tables (mutable provide-ids)
            (mutable require-names)            ; ((name . phase) . module)
            (mutable passes)                   ; ((function-info . form) ...), in order
            (mutable definition-keys)))        ; keys of its phase-0 definitions

  (define current #f)                      ; the comp being expanded

  (define (new-scope!) (set! scope-counter (+ scope-counter 1)) scope-counter)

  ;; The scopes of local binding forms: func, let, let*, block and loop.
  ;; quote-syntax prunes them from its literal (spec 6.2).
  (define local-scopes (make-eqv-hashtable))
  (define (new-local-scope!)
    (let ([sc (new-scope!)]) (hashtable-set! local-scopes sc #t) sc))
  (define (prune-local-scopes x)
    (filter-scopes x (lambda (sc) (not (hashtable-contains? local-scopes sc)))))

  (define core-scope 0)

  ;; ---- the syntax library ----

  (define library-path #f)
  (define syntax-lib #f)                      ; (bytes . infos)
  (define (set-syntax-library-path! p) (set! library-path p))

  (define (ensure-library!)
    (unless syntax-lib
      (let* ([m (make-unit library-path library-path "syntax" 'compiling (make-eqv-hashtable) '() '() '() #f #f)]
             [c (make-comp m #f 0 '() #f (make-eqv-hashtable) (make-eqv-hashtable) (make-eqv-hashtable) '() '() '() '())])
        (with-comp c
          (lambda ()
            (parameterize ([current-syntax-infos #f])
              (let* ([forms (lower-forms (expand-module-body (read-file library-path)) 0)]
                     [forms (append (storage-forms 0) forms)])
                (let-values ([(bytes imports gc?) (compile-module forms "syntax")])
                  (let ([table (make-eq-hashtable)])
                    (for-each (lambda (f) (when (eq? (car f) 'func)
                                            (hashtable-set! table (func-info-name (cadr f)) (cadr f))))
                              forms)
                    (set! syntax-lib (cons bytes table)))))))))))

  (define (syntax-library-bytes) (ensure-library!) (car syntax-lib))

  (define (syntax-info name)
    (or (hashtable-ref (current-syntax-infos) name #f)
        (raise-compile-error #f "internal: the syntax library has no ~a" name)))

  ;; ---- stores ----

  (define (new-cstore compile-time?)
    (ensure-library!)
    (let* ([h (host-new)]
           [st (make-cstore h (make-store h) (make-hashtable string-hash string=?)
                            (make-eq-hashtable) (make-eq-hashtable) 0)])
      (host-set-callback! h expander-callback)
      (when compile-time? (ensure-import! st "syntax" 0))
      st))

  ;; Instance names of module parts: "<module>@<phase>+<shift>" (spec 3.2).
  (define (part-name m q t) (format "~a@~a+~a" (unit-name m) q t))

  (define (parse-part-name s)
    (let ([at (let loop ([i 0]) (cond [(= i (string-length s)) #f]
                                      [(char=? (string-ref s i) #\@) i]
                                      [else (loop (+ i 1))]))]
          [plus (let loop ([i (- (string-length s) 1)]) (cond [(< i 0) #f]
                                                               [(char=? (string-ref s i) #\+) i]
                                                               [else (loop (- i 1))]))])
      (and at plus (< at plus)
           (let ([q (string->number (substring s (+ at 1) plus))]
                 [t (string->number (substring s (+ plus 1) (string-length s)))])
             (and q t (list (substring s 0 at) q t))))))

  ;; Make sure the instance an import names exists in st. imp is relative
  ;; to a module instantiated at `shift`.
  (define (ensure-import! st imp shift)
    (cond [(member imp '("host" "expander")) (void)]
          [(string=? imp "syntax")
           (unless (hashtable-contains? (cstore-instances st) "syntax")
             (host-instantiate! (cstore-host st) "syntax" (car syntax-lib))
             (hashtable-set! (cstore-instances st) "syntax" #t))]
          [(parse-part-name imp)
           => (lambda (p) (ensure-part! st (hashtable-ref modules-by-name (car p) #f) (cadr p) (+ (caddr p) shift)))]
          [else (void)]))                  ; a chunk, already instantiated

  ;; Instantiate module m's phase-q part at shift t in st, dependencies first.
  (define (ensure-part! st m q t)
    (let ([name (part-name m q t)])
      (unless (hashtable-contains? (cstore-instances st) name)
        (let ([p (hashtable-ref (unit-parts m) q #f)])
          (unless p (raise-compile-error #f "internal: ~a has no phase ~a part" (unit-name m) q))
          (for-each (lambda (imp) (ensure-import! st imp t)) (part-imports p))
          (flush-output-port (current-output-port))
          ;; The syntax literals the part builds are shifted too (spec 6.1):
          ;; each module scope in them, module X's copy for shift s, becomes
          ;; X's copy for s + t. The syntax library maps them while the part
          ;; starts.
          (let ([shifted? (and (not (= t 0)) (pair? (part-scopes p)))])
            (when shifted?
              (for-each (lambda (sc)
                          (let ([origin (hashtable-ref module-scope-origins sc #f)])
                            (host-call (cstore-host st) "syntax" "%scope-map-add"
                                       sc (module-scope-at (car origin) (+ (cdr origin) t)))))
                        (part-scopes p)))
            (host-instantiate-shifted! (cstore-host st) name (part-bytes p) t)
            (when shifted?
              (host-call (cstore-host st) "syntax" "%scope-map-clear")))
          (hashtable-set! (cstore-instances st) name #t)))))

  ;; ---- bindings ----

  (define (bind-raw! sym scopes phase meaning)
    (let ([key (fresh-key!)])
      (hashtable-update! bindings sym
                         (lambda (l) (cons (make-binding scopes phase (meaning-namespace meaning) key) l))
                         '())
      (hashtable-set! meanings key meaning)
      key))

  ;; A module-level binding of the current module: recorded, so that a
  ;; module requiring this one at a shift can install a shifted copy.
  (define (bind-module-level! sym scopes phase meaning)
    (let ([key (bind-raw! sym scopes phase meaning)])
      (when current
        (let ([m (comp-module current)])
          (unit-entries-set! m (cons (list sym scopes phase key) (unit-entries m)))))
      key))

  (define (bind! id phase meaning) (bind-raw! (stx-e id) (stx-scopes id) phase meaning))

  (define (check-unbound! id phase meaning)
    (for-each (lambda (b)
                (when (and (eqv? (binding-phase b) phase) (equal? (binding-scopes b) (stx-scopes id))
                           (eq? (binding-namespace b) (meaning-namespace meaning))
                           (not (equal? (hashtable-ref meanings (binding-key b) #f) meaning)))
                  (raise-compile-error id "~a is already bound~a" (stx-e id)
                                       (if (> phase 0) (format " at phase ~a" phase) ""))))
              (hashtable-ref bindings (stx-e id) '())))

  ;; Bind a module-level definition. Use-site scopes come off the name, so
  ;; a definition a macro makes from its input is visible to the rest of
  ;; the module (spec 6.2). A second binding of the same name with the same
  ;; scopes at the same phase is an error, except in what a module pass
  ;; returns, where it replaces this module's definition (spec 6.5).
  (define (bind-definition! id phase meaning)
    (let ([id (remove-scopes id (comp-use-site-scopes current))])
      (unless (and redefining? (redefine! id phase meaning))
        (check-unbound! id phase meaning)
        (let ([key (bind-module-level! (stx-e id) (stx-scopes id) phase meaning)])
          (when (eqv? phase 0)
            (comp-definition-keys-set! current (cons key (comp-definition-keys current))))))))

  ;; Give this module's definition of id, if it has one in the namespace
  ;; of meaning, the new meaning. Returns #f if there is none.
  (define (redefine! id phase meaning)
    (let ([e (find (lambda (e)
                     (and (eq? (car e) (stx-e id)) (equal? (cadr e) (stx-scopes id)) (eqv? (caddr e) phase)
                          (eq? (meaning-namespace (hashtable-ref meanings (cadddr e) #f))
                               (meaning-namespace meaning))))
                   (unit-entries (comp-module current)))])
      (and e (begin (hashtable-set! meanings (cadddr e) meaning) #t))))

  (define (phase-matches? b phase)
    (let ([p (binding-phase b)])
      (or (eq? p 'all) (eqv? p phase))))

  ;; The key id refers to at phase in namespace ns, or #f if unbound.
  (define (resolve id phase ns)
    (let* ([scopes (stx-scopes id)]
           [cands (filter (lambda (b) (and (phase-matches? b phase) (eq? (binding-namespace b) ns)
                                           (scopes-subset? (binding-scopes b) scopes)))
                          (hashtable-ref bindings (stx-e id) '()))])
      (if (null? cands)
          #f
          (let ([best (fold-left (lambda (best b)
                                   (if (> (length (binding-scopes b)) (length (binding-scopes best))) b best))
                                 (car cands) (cdr cands))])
            (for-each (lambda (b)
                        (when (or (not (scopes-subset? (binding-scopes b) (binding-scopes best)))
                                  (and (not (eq? b best)) (equal? (binding-scopes b) (binding-scopes best))
                                       (not (equal? (hashtable-ref meanings (binding-key b) #f)
                                                    (hashtable-ref meanings (binding-key best) #f)))))
                          (raise-compile-error id "identifier ~a is ambiguous" (stx-e id))))
                      cands)
            (binding-key best)))))

  ;; What id means at phase in the value namespace. Only type positions
  ;; (parse-heap, type-of) look in the type namespace, with type-meaning-of.
  (define (meaning-of id phase)
    (let ([key (resolve id phase 'value)])
      (and key (hashtable-ref meanings key #f))))

  (define (type-meaning-of id phase)
    (let ([key (resolve id phase 'type)])
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
    (unless base-installed?
      (set! base-installed? #t)
      (for-each (lambda (name) (bind-raw! name (list core-scope) 'all (list 'core name))) core-forms)
      (for-each (lambda (name) (bind-raw! name (list core-scope) 'all (list 'prim name))) (prim-names))))

  ;; ---- phase shifting ----

  ;; A meaning as seen from `shift` phases up: its part instances move by
  ;; shift. Shifted infos are cached so each is one record.
  (define shifted-infos (make-eq-hashtable))   ; info -> alist shift -> info

  (define (shift-instance inst k)
    (let ([p (and (string? inst) (parse-part-name inst))])
      (if p (format "~a@~a+~a" (car p) (cadr p) (+ (caddr p) k)) inst)))

  (define (shift-info info k)
    (if (= k 0)
        info
        (let* ([cache (hashtable-ref shifted-infos info '())]
               [hit (assv k cache)])
          (if hit
              (cdr hit)
              (let ([new (cond [(func-info? info)
                                (make-func-info (func-info-name info) (func-info-params info) (func-info-results info)
                                                (shift-instance (func-info-instance info) k) (func-info-export info))]
                               [(global-info? info)
                                (make-global-info (global-info-name info) (global-info-type info) (global-info-mutable? info)
                                                  (shift-instance (global-info-instance info) k) (global-info-export info))]
                               [else info])])
                (hashtable-set! shifted-infos info (cons (cons k new) cache))
                new)))))

  (define (shift-meaning meaning k)
    (if (and meaning (memq (car meaning) '(func global macro static)))
        (list (car meaning) (shift-info (cadr meaning) k))
        meaning))

  ;; A module's scope at shift s (spec 6.1). A module used at two shifts has
  ;; bindings at the same phase from both; giving each shift its own copy of
  ;; the module scope keeps them apart. Shift 0 uses the module scope itself.
  (define shifted-scopes (make-hashtable string-hash string=?))
  (define (module-scope-at m s)
    (if (= s 0)
        (unit-scope m)
        (let ([key (format "~a|~a" (unit-path m) s)])
          (or (hashtable-ref shifted-scopes key #f)
              (let ([sc (new-scope!)])
                (hashtable-set! shifted-scopes key sc)
                (hashtable-set! module-scope-origins sc (cons m s))
                sc)))))

  ;; Every module scope, and its copies, as scope -> (module . shift).
  (define module-scope-origins (make-eqv-hashtable))

  ;; The module scopes in syntax literals of lowered forms x (spec 6.1).
  (define (literal-module-scopes x)
    (let ([found (make-eqv-hashtable)])
      (let walk ([x x])
        (cond [(stx? x)
               (for-each (lambda (sc) (when (hashtable-contains? module-scope-origins sc)
                                        (hashtable-set! found sc #t)))
                         (stx-scopes x))
               (walk (stx-e x))]
              [(pair? x) (walk (car x)) (walk (cdr x))]
              [else (void)]))
      (list-sort < (vector->list (hashtable-keys found)))))

  ;; Make module m's bindings resolvable at shift s, and those of the modules
  ;; it requires. Needed for m's macros: their templates carry m's scopes.
  (define (install-module-bindings! m s)
    (let ([key (format "~a|~a" (unit-path m) s)])
      (unless (hashtable-contains? installed key)
        (hashtable-set! installed key #t)
        (unless (= s 0)
          (let ([from (unit-scope m)] [to (module-scope-at m s)])
            (for-each (lambda (e)
                        (bind-raw! (car e) (scopes-add (scopes-remove (cadr e) from) to) (+ (caddr e) s)
                                   (shift-meaning (hashtable-ref meanings (cadddr e) #f) s)))
                      (reverse (unit-entries m)))))
        (for-each (lambda (r) (install-module-bindings! (car r) (+ s (cdr r)))) (unit-requires m)))))

  ;; Compute, in the current store, the value of every static binding m and
  ;; its requires make visible at shift s. Done eagerly, outside any macro
  ;; call, so the handles outlive it.
  (define (prepare-statics! m s)
    (let ([seen (make-hashtable string-hash string=?)])
      (let walk ([m m] [s s])
        (let ([key (format "~a|~a" (unit-path m) s)])
          (unless (hashtable-contains? seen key)
            (hashtable-set! seen key #t)
            (for-each (lambda (e)
                        (let ([meaning (hashtable-ref meanings (cadddr e) #f)])
                          (when (and meaning (eq? (car meaning) 'static))
                            (static-handle (comp-store current) (shift-info (cadr meaning) s)))))
                      (unit-entries m))
            (for-each (lambda (r) (walk (car r) (+ s (cdr r)))) (unit-requires m)))))))

  ;; ==== modules ====================================================================

  (define (with-comp c thunk)
    (let ([saved current])
      (dynamic-wind (lambda () (set! current c)) thunk (lambda () (set! current saved)))))

  (define (normalize-path p)
    (let* ([abs (if (and (> (string-length p) 0) (char=? (string-ref p 0) #\/))
                    p
                    (string-append (current-directory) "/" p))]
           [parts (let split ([s abs] [acc '()] [cur '()])
                    (cond [(= (string-length s) 0) (reverse (cons (list->string (reverse cur)) acc))]
                          [(char=? (string-ref s 0) #\/)
                           (split (substring s 1 (string-length s)) (cons (list->string (reverse cur)) acc) '())]
                          [else (split (substring s 1 (string-length s)) acc (cons (string-ref s 0) cur))]))]
           [kept (fold-left (lambda (acc seg)
                              (cond [(or (string=? seg "") (string=? seg ".")) acc]
                                    [(string=? seg "..") (if (pair? acc) (cdr acc) acc)]
                                    [else (cons seg acc)]))
                            '() parts)])
      (apply string-append (map (lambda (seg) (string-append "/" seg)) (reverse kept)))))

  (define (directory-of path)
    (let loop ([i (- (string-length path) 1)])
      (cond [(< i 0) ""]
            [(char=? (string-ref path i) #\/) (substring path 0 (+ i 1))]
            [else (loop (- i 1))])))

  ;; An instance-name stem from the file name: letters, digits, - and _.
  (define (fresh-unit-name path)
    (let* ([base (let loop ([cs (reverse (string->list path))] [acc '()])
                   (if (or (null? cs) (char=? (car cs) #\/)) (list->string acc) (loop (cdr cs) (cons (car cs) acc))))]
           [stem (let ([dot (let loop ([i (- (string-length base) 1)])
                              (cond [(< i 0) #f] [(char=? (string-ref base i) #\.) i] [else (loop (- i 1))]))])
                   (if dot (substring base 0 dot) base))]
           [clean (list->string (map (lambda (c) (if (or (char-alphabetic? c) (char-numeric? c) (memv c '(#\- #\_))) c #\_))
                                     (string->list stem)))])
      (let loop ([n 1])
        (let ([name (if (= n 1) clean (format "~a-~a" clean n))])
          (if (hashtable-contains? modules-by-name name) (loop (+ n 1)) name)))))

  ;; Compile the module in file `source` (and, first, what it requires).
  ;; Returns the module. Each module is compiled once per run.
  (define (compile-module-file source)
    (let* ([path (normalize-path source)]
           [known (hashtable-ref registry path #f)])
      (cond
        [(and known (eq? (unit-state known) 'done)) known]
        [known (raise-compile-error #f "cyclic require: ~a requires itself" source)]
        [else
         (unless (file-exists? source) (raise-compile-error #f "no module file ~a" source))
         (ensure-library!)
         (let* ([name (fresh-unit-name path)]
                [m (make-unit path source name 'compiling (make-eqv-hashtable) '() '() '() #f #f)]
                [c (make-comp m (new-cstore #t) 0 '() #f
                              (make-eqv-hashtable) (make-eqv-hashtable) (make-eqv-hashtable) '() '() '() '())])
           (hashtable-set! registry path m)
           (hashtable-set! modules-by-name name m)
           (with-comp c
             (lambda ()
               (parameterize ([current-syntax-infos (cdr syntax-lib)])
                 (unit-expanded-set! m (expand-module-body (read-file source)))
                 (finish-module! c))))
           m)])))

  ;; Expand a module body at phase 0; phase >= 1 code runs as it goes.
  (define (expand-module-body forms)
    (install-base!)
    (let ([msc (new-scope!)])
      (unit-scope-set! (comp-module current) msc)
      (hashtable-set! module-scope-origins msc (cons (comp-module current) 0))
      (expand-body (map-lr (lambda (f) (add-scope (add-scope f core-scope) msc)) forms) 0)))

  (define (add-phase-forms! phase forms)
    (let ([t (comp-phase-forms current)])
      (hashtable-set! t phase (append (reverse forms) (hashtable-ref t phase '())))))

  ;; The memory and table forms declared for phase (spec 3.3).
  (define (storage-forms phase)
    (let ([mem (hashtable-ref (comp-memories current) phase #f)]
          [tbl (hashtable-ref (comp-tables current) phase #f)])
      (append (if mem (list mem) '()) (if tbl (list tbl) '()))))

  ;; Run the module passes over the expanded phase-0 code, resolve provides,
  ;; compile each phase's part, check (runtime-free).
  (define (finish-module! c)
    (let ([m (comp-module c)])
      (unit-expanded-set! m (apply-module-passes c (unit-expanded m)))
      (removed-definitions (definitions-removed c (unit-expanded m)))
      (add-phase-forms! 0 (lower-forms (unit-expanded m) 0))
      ;; A provided name exports its binding in each namespace it has one.
      (unit-provides-set!
       m
       (apply append
              (map-lr (lambda (id)
                        (let* ([value (let ([v (meaning-of id 0)])
                                        (and v (memq (car v) '(func global macro static data)) v))]
                               [found (filter values (list (type-meaning-of id 0) value))])
                          (when (null? found)
                            (raise-compile-error id "cannot provide ~a: it is not a module-level binding" (stx-e id)))
                          (for-each (lambda (meaning) (check-not-removed (cadr meaning) id)) found)
                          (map (lambda (meaning) (cons (stx-e id) meaning)) found)))
                      (reverse (comp-provide-ids c)))))
      (removed-definitions #f)
      (let ([phases (list-sort < (let-values ([(ks vs) (hashtable-entries (comp-phase-forms c))])
                                   (let ([ps (vector->list ks)]) (if (memv 0 ps) ps (cons 0 ps)))))])
        (for-each (lambda (p)
                    (let ([forms (append (storage-forms p) (reverse (hashtable-ref (comp-phase-forms c) p '())))])
                      (let-values ([(bytes imports gc?) (compile-module forms (part-name m p 0))])
                        (hashtable-set! (unit-parts m) p
                                        (make-part bytes imports gc? (literal-module-scopes forms))))))
                  phases))
      (hashtable-set! installed (format "~a|0" (unit-path m)) #t)
      (unit-state-set! m 'done)
      (let ([form (comp-runtime-free-form c)])
        (when form (check-runtime-free! m form)))))

  ;; The parts a program instantiates at run time: phase 0 at shift 0,
  ;; reached through phase-0 requires.
  (define (runtime-closure m)
    (let loop ([todo (list m)] [seen '()])
      (cond [(null? todo) (reverse seen)]
            [(memq (car todo) seen) (loop (cdr todo) seen)]
            [else
             (let* ([p (hashtable-ref (unit-parts (car todo)) 0 #f)]
                    [deps (filter values
                                  (map (lambda (imp)
                                         (let ([pp (parse-part-name imp)])
                                           (and pp (= (cadr pp) 0) (= (caddr pp) 0)
                                                (hashtable-ref modules-by-name (car pp) #f))))
                                       (part-imports p)))])
               (loop (append (cdr todo) deps) (cons (car todo) seen)))])))

  ;; (runtime-free): the program's run-time parts import only from the host
  ;; and each other, and use no GC (spec 3.4).
  (define (check-runtime-free! m form)
    (for-each (lambda (mm)
                (let* ([p (hashtable-ref (unit-parts mm) 0 #f)]
                       [extra (filter (lambda (imp) (not (or (string=? imp "host") (parse-part-name imp))))
                                      (part-imports p))])
                  (unless (and (null? extra) (not (part-gc? p)))
                    (raise-compile-error form
                                         "this module is declared runtime-free, but after expansion ~a ~a"
                                         (if (eq? mm m) "it" (format "the module ~a it requires" (unit-name mm)))
                                         (if (pair? extra) (format "imports from ~a" extra) "uses GC objects")))))
              (runtime-closure m)))

  ;; The fully expanded phase-0 forms of m, for `subc expand`.
  (define (module-expanded-forms m) (unit-expanded m))

  ;; (phase . bytes) for each part of m.
  (define (module-part-list m)
    (list-sort (lambda (a b) (< (car a) (car b)))
               (let-values ([(ks vs) (hashtable-entries (unit-parts m))])
                 (map (lambda (k v) (cons k (part-bytes v))) (vector->list ks) (vector->list vs)))))

  ;; Instantiate m's program in a fresh run-time store and call its main.
  (define (run-module m)
    (let ([st (new-cstore #f)])
      (ensure-part! st m 0 0)
      (guard (c [(and (wasm-failure? c)
                      (let ([msg (wasm-failure-message c)])
                        (and (>= (string-length msg) 17) (string=? (substring msg 0 17) "call: no function"))))
                 (void)])
        (host-call (cstore-host st) (part-name m 0 0) "main"))))

  ;; ==== module bodies ============================================================

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
            (head-expand (apply-macro head (cadr m) s phase #t) phase)
            s))))

  ;; True while expanding the forms a module pass returned (spec 6.5).
  (define redefining? #f)

  ;; A module body being expanded: its phase, the items pass 1 found
  ;; (reversed), whether pass 2 has started, and the expanded forms lifted
  ;; while pass 2 expands the current item (reversed).
  (define-record-type body (fields phase (mutable items) (mutable pass2?) (mutable lifted)))

  (define current-body #f)                 ; the innermost body being expanded

  ;; A module body -> its expanded code: func, global, import, type and
  ;; data forms and expressions (spec 6.4). Other module-level forms take
  ;; effect during expansion and leave nothing.
  (define (expand-body forms phase)
    (let ([b (make-body phase '() #f '())] [saved current-body])
      (dynamic-wind
        (lambda () (set! current-body b))
        (lambda ()
          ;; Pass 1: find definitions, run compile-time forms, splice begins.
          (for-each (lambda (f) (declare-form! f b (and redefining? "a module pass returned"))) forms)
          ;; Pass 2: expand bodies and expressions. What an item lifts goes
          ;; before it.
          (body-pass2?-set! b #t)
          (apply append
                 (map-lr (lambda (item)
                           (body-lifted-set! b '())
                           (let ([out (expand-item item phase)])
                             (append (reverse (body-lifted b)) (list out))))
                         (reverse (body-items b)))))
        (lambda () (set! current-body saved)))))

  ;; Pass 1 for module-level form f0 of body b: expand macro uses at its
  ;; head, then declare it, run it, or keep it for pass 2. only is #f, or
  ;; says where the form came from if it may only be a definition or an
  ;; expression (what a module pass returns, or what a macro lifts).
  (define (declare-form! f0 b only)
    (let* ([phase (body-phase b)]
           [f (head-expand f0 phase)]
           [kind (core-head f phase)])
      (define (item! x) (body-items-set! b (cons x (body-items b))))
      (when (and only
                 (memq kind '(require provide runtime-free module-pass memory table
                              define-syntax define-static begin-for-syntax)))
        (raise-compile-error f "~a (~a ...), but only func, global, import, type and data forms and expressions are allowed there"
                             only kind))
      (case kind
        [(begin) (for-each (lambda (g) (declare-form! g b only)) (cdr (stx-list-of f 'begin)))]
        [(require) (require! f phase)]
        [(provide) (provide! f phase)]
        [(runtime-free) (runtime-free! f phase)]
        [(module-pass) (module-pass! f phase)]
        [(func) (item! (declare-func f phase))]
        [(global) (item! (declare-global f phase))]
        [(import) (item! (declare-import f phase))]
        [(memory table) (declare-storage! f phase)]
        [(data) (item! (declare-data f phase))]
        [(type) (item! (declare-type f phase))]
        [(define-syntax) (define-syntax! f phase)]
        [(define-static) (define-static! f phase)]
        [(begin-for-syntax) (begin-for-syntax! f phase)]
        [else (item! (list 'expr f))])))

  ;; Pass 2 for one item: its expanded code.
  (define (expand-item item phase)
    (case (car item)
      [(func) (expand-func item phase)]
      [(global) (expand-global item phase)]
      [(plain) (cadr item)]
      [(expr) (expand-expr (cadr item) phase)]))

  ;; Lift form, from a macro, to the module level of the body being
  ;; expanded (spec 6.4): declare it now, so its names can be used at once,
  ;; and put its expanded code before the form whose expansion lifted it.
  (define (lift! form where phase)
    (let ([b current-body])
      (unless (and b (eqv? (body-phase b) phase))
        (raise-compile-error where "lift-definition: no module body is being expanded at phase ~a" phase))
      (let ([before (body-items b)])
        (declare-form! form b "lift-definition was given")
        ;; In pass 2 the new items are expanded now; in pass 1 they wait
        ;; for pass 2 like the others.
        (when (body-pass2? b)
          (let ([new (list-head (body-items b) (- (length (body-items b)) (length before)))])
            (body-items-set! b before)
            (for-each (lambda (item)
                        (let ([out (expand-item item phase)])
                          (body-lifted-set! b (cons out (body-lifted b)))))
                      (reverse new)))))))

  ;; ==== types ====================================================================

  (define shorthand-refs
    '((anyref . any) (eqref . eq) (i31ref . i31) (structref . struct) (arrayref . array)
      (funcref . func) (externref . extern)))

  ;; A heap type: an abstract name, or a type declared with `type`.
  (define (parse-heap s phase)
    (cond [(and (id? s) (memq (stx-e s) abstract-heaps)) (stx-e s)]
          [(id? s)
           (let ([m (type-meaning-of s phase)])
             (unless m (raise-compile-error s "~a is not a type" (stx-e s)))
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

  ;; The words of type syntax are compared by name, like wasm's keywords, so
  ;; they are reserved: no declared type may be named by one (spec 5.1).
  (define (core-name? s name) (and (id? s) (eq? (stx-e s) name)))

  (define type-keywords '(ref null mut struct array field sub final func rec ->))

  (define (check-type-name! id)
    (let ([name (stx-e id)])
      (cond [(or (memq name (append abstract-heaps '(i32 i64 f32 f64 i8 i16)))
                 (assq name shorthand-refs))
             (raise-compile-error id "~a names a built-in type" name)]
            [(memq name type-keywords)
             (raise-compile-error id "~a is a word of type syntax, so it cannot name a type" name)])))

  ;; A field or element type: a storage type, optionally (mut storage).
  (define (parse-field-type s phase)
    (let ([parts (stx->list s)])
      (if (and parts (= (length parts) 2) (core-name? (car parts) 'mut))
          (list (parse-storage (cadr parts) phase) #t)
          (list (parse-storage s phase) #f))))

  (define (parse-storage s phase)
    (if (and (id? s) (memq (stx-e s) '(i8 i16))) (stx-e s) (parse-type s phase)))

  ;; ---- macros in types ----
  ;;
  ;; In a type position, a form whose head is a macro is expanded until it
  ;; is not (spec 5.1): a type function. The expand- functions return type
  ;; syntax with every such use expanded, which is what expanded code holds;
  ;; the parse- functions then read it.

  ;; The macro meaning of s's head if s is (macro ...), else #f.
  (define (type-macro-use s phase)
    (and (stx? s) (pair? (stx-e s)) (id? (car (stx-e s)))
         (let ([m (meaning-of (car (stx-e s)) phase)])
           (and m (eq? (car m) 'macro) m))))

  ;; A type name or heap type: macro uses at its head expanded.
  (define (expand-type-name s phase)
    (let ([m (type-macro-use s phase)])
      (if m (expand-type-name (apply-macro (car (stx-e s)) (cadr m) s phase #f) phase) s)))

  ;; A value type.
  (define (expand-type s phase)
    (let* ([s (expand-type-name s phase)]
           [l (stx->list s)])
      (if (and l (memv (length l) '(2 3)) (core-name? (car l) 'ref))
          (stx-rewrap s (append (list-head l (- (length l) 1)) (list (expand-type-name (list-ref l (- (length l) 1)) phase))))
          s)))

  ;; A field, element or global type: a type, i8, i16, or (mut ...) of one.
  (define (expand-field-type s phase)
    (let ([l (stx->list s)])
      (cond [(and l (= (length l) 2) (core-name? (car l) 'mut))
             (stx-rewrap s (list (car l) (expand-field-type (cadr l) phase)))]
            [(and (id? s) (memq (stx-e s) '(i8 i16))) s]
            [else (expand-type s phase)])))

  ;; A signature (t ... -> r ...).
  (define (expand-signature s phase)
    (let ([l (stx-list-of s "signature")])
      (stx-rewrap s (map-lr (lambda (t) (if (core-name? t '->) t (expand-type t phase))) l))))

  ;; The result part of a func, `-> r`, where r is one type or a list of
  ;; them. A macro use is one type, though it looks like a list.
  (define (expand-arrow arrow phase)
    (if (null? arrow)
        arrow
        (let* ([r (cadr arrow)] [l (stx->list r)])
          (list (car arrow)
                (if (and l (pair? l) (not (core-name? (car l) 'ref)) (not (type-macro-use r phase)))
                    (stx-rewrap r (map-lr (lambda (t) (expand-type t phase)) l))
                    (expand-type r phase))))))

  ;; A type definition: (struct (field name t) ...), (array t), or
  ;; (sub ... def).
  (define (expand-type-def s phase)
    (let ([l (stx->list s)])
      (cond [(and l (pair? l) (core-name? (car l) 'sub))
             (stx-rewrap s (append (list-head l (- (length l) 1)) (list (expand-type-def (list-ref l (- (length l) 1)) phase))))]
            [(and l (pair? l) (core-name? (car l) 'struct))
             (stx-rewrap s (cons (car l)
                                 (map-lr (lambda (fs)
                                           (let ([fp (stx->list fs)])
                                             (if (and fp (= (length fp) 3))
                                                 (stx-rewrap fs (list (car fp) (cadr fp) (expand-field-type (caddr fp) phase)))
                                                 fs)))
                                         (cdr l))))]
            [(and l (= (length l) 2) (core-name? (car l) 'array))
             (stx-rewrap s (list (car l) (expand-field-type (cadr l) phase)))]
            [else s])))

  ;; (type name def), where def is (struct (field fname ftype) ...),
  ;; (array etype), or (sub [final] [super] def) as in wasm (spec 5.3). A
  ;; def without sub is final, with no supertype. The name is bound before
  ;; the fields are read, so a type may refer to itself.
  (define (declare-type f phase)
    (let ([parts (stx-list-of f 'type)])
      (unless (and (= (length parts) 3) (id? (cadr parts)) (stx->list (caddr parts))
                   (pair? (stx->list (caddr parts))))
        (raise-compile-error f "expected (type name (struct field ...)) or (type name (array type))"))
      (check-type-name! (cadr parts))
      (let-values ([(def final? super) (parse-sub (caddr parts) phase)])
        (let ([kind (stx-e (car (stx->list def)))])
          (unless (memq kind '(struct array))
            (raise-compile-error def "a type is (struct field ...), (array type) or (sub ...)"))
          (when super
            (unless (eq? (type-info-kind super) kind)
              (raise-compile-error (caddr parts) "a~a type cannot have the ~a type ~a as its supertype"
                                   (if (eq? kind 'struct) " struct" "n array") (type-info-kind super)
                                   (type-info-name super)))
            (when (type-info-final? super)
              (raise-compile-error (caddr parts) "~a is final: it cannot be a supertype" (type-info-name super))))
          (let ([info (make-type-info (stx-e (cadr parts)) kind #f super final?)])
            (bind-definition! (cadr parts) phase (list 'type info))
            ;; The field types are expanded after the name is bound, so a
            ;; type function may be given the type being declared.
            (let*-values ([(xdef) (expand-type-def (caddr parts) phase)]
                          [(xinner xfinal? xsuper) (parse-sub xdef phase)])
              (type-info-fields-set! info (parse-type-fields xinner kind phase))
              (when super (check-subtype-fields! info super xinner))
              (list 'plain (out f 'type (cadr parts) xdef))))))))

  ;; (sub [final] [super] def) -> def, final?, super's type-info or #f.
  (define (parse-sub s phase)
    (let ([l (stx->list s)])
      (if (core-name? (car l) 'sub)
          (let* ([rest (cdr l)]
                 [final? (and (pair? rest) (core-name? (car rest) 'final))]
                 [rest (if final? (cdr rest) rest)])
            (case (length rest)
              [(1) (values (car rest) final? #f)]
              [(2) (values (cadr rest) final? (type-of (car rest) phase))]
              [else (raise-compile-error s "expected (sub [final] [supertype] (struct ...) or (array ...))")]))
          (values s #t #f))))

  (define (parse-type-fields def kind phase)
    (let ([l (stx->list def)])
      (if (eq? kind 'struct)
          (map-lr (lambda (fs)
                    (let ([fp (stx->list fs)])
                      (unless (and fp (= (length fp) 3) (core-name? (car fp) 'field) (id? (cadr fp)))
                        (raise-compile-error fs "expected (field name type)"))
                      (cons (stx-e (cadr fp)) (parse-field-type (caddr fp) phase))))
                  (cdr l))
          (begin
            (unless (= (length l) 2) (raise-compile-error def "expected (array type)"))
            (parse-field-type (cadr l) phase)))))

  ;; Wasm's rule for a declared supertype: a struct starts with its
  ;; supertype's fields, and an array's element matches. An immutable field
  ;; may narrow its type; a mutable one keeps it.
  (define (check-subtype-fields! info super where)
    (define (field<=? a b)                 ; (storage mutable?)
      (and (eq? (cadr a) (cadr b))
           (if (or (memq (car a) '(i8 i16)) (memq (car b) '(i8 i16)))
               (eq? (car a) (car b))
               (and (valtype<=? (car a) (car b)) (or (not (cadr a)) (valtype<=? (car b) (car a)))))))
    (if (eq? (type-info-kind info) 'struct)
        (let ([mine (type-info-fields info)] [theirs (type-info-fields super)])
          (when (< (length mine) (length theirs))
            (raise-compile-error where "~a has fewer fields than its supertype ~a"
                                 (type-info-name info) (type-info-name super)))
          (for-each (lambda (a b)
                      (unless (field<=? (cdr a) (cdr b))
                        (raise-compile-error where "~a's field ~a does not match field ~a of its supertype ~a"
                                             (type-info-name info) (car a) (car b) (type-info-name super))))
                    (list-head mine (length theirs)) theirs))
        (unless (field<=? (type-info-fields info) (type-info-fields super))
          (raise-compile-error where "~a's element type does not match its supertype ~a's"
                               (type-info-name info) (type-info-name super)))))

  (define (type-of id phase)
    (let ([m (and (id? id) (type-meaning-of id phase))])
      (unless m (raise-compile-error id "~s is not a declared type" (stx->datum id)))
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
                                 (list (car pp) (expand-type (cadr pp) phase))))
                             (cdr hparts))]
             [types (map-lr (lambda (pp) (parse-type (cadr pp) phase)) params)]
             [rest (cddr parts)]
             [arrow (if (and (pair? rest) (core-name? (car rest) '->))
                        (begin
                          (when (null? (cdr rest)) (raise-compile-error (car rest) "expected a type after ->"))
                          (expand-arrow (list-head rest 2) phase))
                        '())])
        (let-values ([(results body) (parse-results (append arrow (list-tail rest (length arrow))) phase)])
          (let ([info (make-func-info (stx-e name) types results #f #f)])
            (bind-definition! name phase (list 'func info))
            (list 'func name params arrow body f))))))

  ;; (func (name [p t] ...) [-> r] body ...), expanded.
  (define (expand-func p phase)
    (let* ([name (list-ref p 1)] [params (list-ref p 2)] [arrow (list-ref p 3)] [body (list-ref p 4)]
           [f (list-ref p 5)]
           [sc (new-local-scope!)]
           [xs (map-lr (lambda (pp) (let ([x (add-scope (car pp) sc)]) (bind-local! x phase) x)) params)])
      (apply out f 'func
             (out-list (cadr (stx->list f))
                       (cons name (map-lr (lambda (x pp) (out-list x (list x (cadr pp)))) xs params)))
             (append arrow (map-lr (lambda (b) (expand-expr (add-scope b sc) phase)) body)))))

  ;; (global name type init) or (global name (mut type) init), as in wasm.
  (define (declare-global f phase)
    (let ([parts (stx-list-of f 'global)])
      (unless (and (= (length parts) 4) (id? (cadr parts)))
        (raise-compile-error f "expected (global name type init) or (global name (mut type) init)"))
      (let* ([xt (expand-field-type (caddr parts) phase)]
             [t (stx->list xt)]
             [mutable? (and t (= (length t) 2) (core-name? (car t) 'mut))]
             [info (make-global-info (stx-e (cadr parts)) (parse-type (if mutable? (cadr t) xt) phase)
                                     mutable? #f #f)])
        (bind-definition! (cadr parts) phase (list 'global info))
        (list 'global f xt))))

  (define (expand-global p phase)
    (let ([parts (stx->list (cadr p))])
      (out (cadr p) 'global (cadr parts) (caddr p) (expand-expr (cadddr parts) phase))))

  ;; (import name "module" "field" (t ... -> r ...))
  (define (declare-import f phase)
    (let ([parts (stx-list-of f 'import)])
      (unless (and (= (length parts) 5) (id? (cadr parts))
                   (string? (stx-e (caddr parts))) (string? (stx-e (cadddr parts))))
        (raise-compile-error f "expected (import name \"module\" \"field\" (type ... -> type ...))"))
      (let ([sig (expand-signature (list-ref parts 4) phase)])
        (let-values ([(params results) (parse-signature sig phase)])
          (bind-definition! (cadr parts) phase
                 (list 'func (make-func-info (stx-e (cadr parts)) params results
                                             (stx-e (caddr parts)) (stx-e (cadddr parts)))))
          (list 'plain (out f 'import (cadr parts) (caddr parts) (cadddr parts) sig))))))


  ;; (data name offset "bytes" ...): an active segment in the module's memory.
  (define (declare-data f phase)
    (let ([parts (stx-list-of f 'data)])
      (unless (and (>= (length parts) 3) (id? (cadr parts))
                   (fixnum? (stx-e (caddr parts))) (>= (stx-e (caddr parts)) 0)
                   (for-all (lambda (s) (string? (stx-e s))) (cdddr parts)))
        (raise-compile-error f "expected (data name offset \"bytes\" ...)"))
      (let ([info (make-data-info (stx-e (cadr parts)) (stx-e (caddr parts))
                                  (string->utf8 (apply string-append (map stx-e (cdddr parts)))))])
        (bind-definition! (cadr parts) phase (list 'data info))
        (list 'plain (core-headed f 'data)))))

  ;; ---- require, provide, storage ----

  ;; (require name source item ...), where source is "path" or syntax (the
  ;; syntax library). Everything the source provides is bound as name:thing.
  ;; Each item also binds one thing unqualified: x as itself, or [new old]
  ;; as new. A require at phase p imports at phase p; inside
  ;; begin-for-syntax it imports for compile-time code (spec 3.1).
  (define (require! f phase)
    (let ([parts (stx-list-of f 'require)])
      (unless (and (>= (length parts) 3) (id? (cadr parts))
                   (or (string? (stx-e (caddr parts))) (core-name? (caddr parts) 'syntax)))
        (raise-compile-error f "expected (require name \"path\" item ...) or (require name syntax item ...)"))
      (let* ([name (cadr parts)]
             [source (caddr parts)]
             [provided (if (string? (stx-e source))
                           (require-module! f name source phase)
                           (require-syntax! source phase))])
        (for-each (lambda (p) (bind-import! (qualified name (car p)) phase (cdr p))) provided)
        (for-each (lambda (item)
                    (let* ([l (stx->list item)]
                           [new (cond [(id? item) item]
                                      [(and l (= (length l) 2) (id? (car l)) (id? (cadr l))) (car l)]
                                      [else (raise-compile-error item "expected a name or [new-name name]")])]
                           [old (if (id? item) item (cadr l))]
                           [ps (filter (lambda (p) (eq? (car p) (stx-e old))) provided)])
                      (when (null? ps)
                        (raise-compile-error old "~a does not provide ~a" (stx-e source) (stx-e old)))
                      (for-each (lambda (p) (bind-import! new phase (cdr p))) ps)))
                  (cdddr parts)))))

  ;; name:thing, with the scopes of name.
  (define (qualified name sym)
    (datum->stx name (string->symbol (format "~a:~a" (stx-e name) sym)) (stx-srcloc name)))

  (define (bind-import! id phase meaning)
    (check-unbound! id phase meaning)
    (bind-module-level! (stx-e id) (stx-scopes id) phase meaning))

  ;; The syntax library's contract functions (spec 2.3), as (symbol . meaning).
  (define (require-syntax! source phase)
    (unless (current-syntax-infos)
      (raise-compile-error source "the syntax library cannot require itself"))
    (let-values ([(names infos) (hashtable-entries (current-syntax-infos))])
      ;; sorted, for deterministic keys
      (map (lambda (info) (cons (func-info-name info) (list 'func info)))
           (list-sort (lambda (a b) (string<? (symbol->string (func-info-name a))
                                               (symbol->string (func-info-name b))))
                      (filter (lambda (info) (not (internal-name? (func-info-name info))))
                              (vector->list infos))))))

  (define (module-path-of f spec)
    (let* ([loc (stx-srcloc f)]
           [dir (if loc (directory-of (symbol->string (srcloc-source loc))) "")]
           [given (stx-e spec)])
      (if (and (> (string-length given) 0) (char=? (string-ref given 0) #\/))
          given
          (string-append dir given))))

  ;; Compile the module if needed and make its own bindings resolvable for
  ;; its macros. Returns what it provides, as seen from phase.
  (define (require-module! f name spec phase)
    (let* ([m (compile-module-file (module-path-of f spec))]
           [me (comp-module current)]
           [req (cons m phase)]
           [key (cons (stx-e name) phase)]
           [named (assoc key (comp-require-names current))])
      (when (and named (not (eq? (cdr named) m)))
        (raise-compile-error name "~a already names another module at this phase" (stx-e name)))
      (unless named
        (comp-require-names-set! current (cons (cons key m) (comp-require-names current))))
      (unless (member req (unit-requires me))
        (unit-requires-set! me (append (unit-requires me) (list req)))
        (install-module-bindings! m phase)
        (prepare-statics! m phase))
      (map (lambda (p) (cons (car p) (shift-meaning (cdr p) phase))) (unit-provides m))))

  ;; The module a require named at this phase.
  (define (required-module name phase)
    (let ([named (and (id? name) (assoc (cons (stx-e name) phase) (comp-require-names current)))])
      (unless named
        (raise-compile-error name "~s is not the name of a module required at this phase" (stx->datum name)))
      (cdr named)))


  ;; (provide id ...): the phase-0 bindings other modules get by requiring
  ;; this one.
  (define (provide! f phase)
    (unless (= phase 0) (raise-compile-error f "provide belongs at phase 0"))
    (let ([ids (cdr (stx-list-of f 'provide))])
      (for-each (lambda (id) (unless (id? id) (raise-compile-error id "provide takes identifiers"))) ids)
      (comp-provide-ids-set! current (append (reverse ids) (comp-provide-ids current)))))

  ;; (memory pages) or (memory from name), and likewise (table ...): the
  ;; module's memory or table at this phase. name is a module required at
  ;; this phase (spec 3.3).
  (define (declare-storage! f phase)
    (let* ([parts (stx-list-of f 'memory)]
           [kind (stx-e (car parts))]
           [table (if (eq? kind 'memory) (comp-memories current) (comp-tables current))])
      (when (hashtable-ref table phase #f)
        (raise-compile-error f "a second ~a declaration at this phase" kind))
      (hashtable-set!
       table phase
       (cond
         [(and (= (length parts) 2) (fixnum? (stx-e (cadr parts))) (>= (stx-e (cadr parts)) 0))
          (unless (= phase 0)
            (raise-compile-error f "v0 defines ~as at phase 0 only; at phase ~a use (~a from name)"
                                 kind phase kind))
          (list kind (stx-e (cadr parts)))]
         [(and (= (length parts) 3) (core-name? (cadr parts) 'from))
          (let ([m (required-module (caddr parts) phase)])
            (list (if (eq? kind 'memory) 'memory-import 'table-import) (part-name m 0 phase)))]
         [else (raise-compile-error f "expected (~a size) or (~a from name)" kind kind)]))))

  ;; (runtime-free): after expansion, the program needs nothing beyond the
  ;; host at run time (spec 3.4).
  (define (runtime-free! f phase)
    (unless (and (= phase 0) (equal? (map stx-e (stx-list-of f 'runtime-free)) '(runtime-free)))
      (raise-compile-error f "(runtime-free) takes nothing and belongs at phase 0"))
    (comp-runtime-free-form-set! current f))

  ;; ==== compile-time evaluation ===================================================

  (define (next-chunk-name! prefix)
    (let ([n (comp-chunk-counter current)])
      (comp-chunk-counter-set! current (+ n 1))
      (format "~a#~a" prefix n)))

  ;; Compile forms and instantiate them in store st, after what they import.
  (define (instantiate-chunk! st name forms where)
    (let-values ([(bytes imports gc?) (compile-module forms name)])
      (for-each (lambda (imp) (ensure-import! st imp 0)) imports)
      (guard (c [(wasm-failure? c)
                 (raise-compile-error where "compile-time code failed: ~a" (wasm-failure-message c))])
        (flush-output-port (current-output-port))
        (host-instantiate! (cstore-host st) name bytes))
      (hashtable-set! (cstore-instances st) name #t)
      name))

  ;; A chunk of this module's phase-`phase` code, run now. It also becomes
  ;; part of the module's phase-`phase` part.
  (define (run-chunk! forms phase where)
    (add-phase-forms! phase forms)
    (instantiate-chunk! (comp-store current)
                        (next-chunk-name! (format "~a@~a" (unit-name (comp-module current)) phase))
                        (append (storage-forms phase) forms)
                        where))

  ;; A one-function chunk in st giving Chez an i32 entry point: it turns
  ;; handles into references around `body`, which returns an eqref.
  (define (entry-chunk! st param? body)
    (let* ([key (and param? (fresh-key!))]
           [entry (make-func-info '__entry (if param? '(i32) '()) '(i32) #f #f)]
           [body (body (and param? (list 'call (syntax-info '%deref) (list (list 'lref key)))))])
      (cstore-counter-set! st (+ (cstore-counter st) 1))
      (instantiate-chunk! st (format "entry#~a" (cstore-counter st))
                          (list (list 'func entry (if param? (list (cons key 'i32)) '())
                                      (list 'call (syntax-info '%handle) (list body))))
                          #f)))

  ;; The entry chunk that calls transformer f, in st.
  (define (macro-entry st f)
    (or (hashtable-ref (cstore-wrappers st) f #f)
        (let ([chunk (entry-chunk! st #t (lambda (arg) (list 'call f (list arg))))])
          (hashtable-set! (cstore-wrappers st) f chunk)
          chunk)))

  ;; The handle of a static value in st, from its getter function.
  (define (static-handle st getter)
    (or (hashtable-ref (cstore-statics st) getter #f)
        (let* ([chunk (entry-chunk! st #f (lambda (_) (list 'call getter '())))]
               [h (call-in-store st #f (lambda (host) (host-call host chunk "__entry")))])
          (hashtable-set! (cstore-statics st) getter h)
          h)))

  ;; (define-syntax name f): name is a macro whose transformer is the phase+1
  ;; function f, of type (eqref) -> eqref, from an earlier begin-for-syntax
  ;; or a module required inside begin-for-syntax.
  (define (define-syntax! f phase)
    (let ([parts (stx-list-of f 'define-syntax)])
      (unless (and (= (length parts) 3) (id? (cadr parts)) (id? (caddr parts)))
        (raise-compile-error f "expected (define-syntax name transformer-function)"))
      (bind-definition! (cadr parts) phase
                        (list 'macro (syntax-function-of (caddr parts) phase "a transformer")))))

  ;; The phase+1 function id names, checked to take and return syntax and
  ;; to be defined already: a transformer or a module pass.
  (define (syntax-function-of id phase what)
    (let ([m (meaning-of id (+ phase 1))])
      (unless (and m (eq? (car m) 'func))
        (raise-compile-error id "~a is not a function at phase ~a" (stx-e id) (+ phase 1)))
      (let ([info (cadr m)])
        (unless (and (equal? (func-info-params info) (list eqref))
                     (types<=? (func-info-results info) (list eqref)))
          (raise-compile-error id "~a takes one eqref (syntax) and returns one eqref" what))
        (unless (func-info-instance info)
          (raise-compile-error id "~a must be defined by an earlier begin-for-syntax" (stx-e id)))
        info)))

  ;; (module-pass f): once the module is expanded, the phase+1 function f
  ;; rewrites its expanded phase-0 code (spec 6.5). Passes run in the order
  ;; they are declared.
  (define (module-pass! f phase)
    (let ([parts (stx-list-of f 'module-pass)])
      (unless (and (= (length parts) 2) (id? (cadr parts)))
        (raise-compile-error f "expected (module-pass function)"))
      (unless (= phase 0)
        (raise-compile-error f "module-pass belongs at phase 0"))
      (comp-passes-set! current (append (comp-passes current)
                                        (list (cons (syntax-function-of (cadr parts) phase "a module pass") f))))))

  ;; (define-static name expr): name is bound to the value of expr at
  ;; phase+1. The value lives in a global of the phase+1 part, computed when
  ;; the part is instantiated; macros read it with syntax-local-value.
  (define (define-static! f phase)
    (let ([parts (stx-list-of f 'define-static)])
      (unless (and (= (length parts) 3) (id? (cadr parts)))
        (raise-compile-error f "expected (define-static name expr)"))
      (let* ([name (string->symbol (string-append "__static." (symbol->string (stx-e (cadr parts)))))]
             [rhs (lower-expr (expand-expr (caddr parts) (+ phase 1)) (+ phase 1))]
             [global (make-global-info name eqref #t #f #f)]
             [getter (make-func-info name '() (list eqref) #f #f)])
        (run-chunk! (list (list 'global global rhs) (list 'func getter '() (list 'gref global)))
                    (+ phase 1) f)
        (static-handle (comp-store current) getter)
        (bind-definition! (cadr parts) phase (list 'static getter)))))

  ;; (begin-for-syntax form ...)
  (define (begin-for-syntax! f phase)
    (let ([forms (expand-body (cdr (stx-list-of f 'begin-for-syntax)) (+ phase 1))])
      (run-chunk! (lower-forms forms (+ phase 1)) (+ phase 1) f)))

  ;; ==== macros ======================================================================

  ;; State the expander query callbacks read.
  (define api-phase 0)
  (define api-where #f)               ; the form the running macro was given
  (define api-intro #f)               ; its introduction scope
  (define api-error #f)

  (define (call-in-store st where proc)
    (set! api-error #f)
    (guard (c [(wasm-failure? c)
               (if api-error
                   (let ([e api-error]) (set! api-error #f) (raise e))
                   (raise-compile-error where "~a" (wasm-failure-message c)))])
      (flush-output-port (current-output-port))
      (proc (cstore-host st))))

  ;; Hygiene (spec 6.2): a fresh introduction scope is flipped on the input
  ;; and on the output, so only what the transformer introduced carries it.
  ;; In a definition context (use-site? is true) the input also gets a fresh
  ;; use-site scope, which stays.
  (define (apply-macro head transformer s phase use-site?)
    (let* ([intro (new-scope!)]
           [s (flip-scope s intro)]
           [s (if use-site?
                  (let ([use (new-scope!)])
                    (comp-use-site-scopes-set! current (cons use (comp-use-site-scopes current)))
                    (add-scope s use))
                  s)])
      (flip-scope (call-syntax-function (format "macro ~a" (stx-e head)) transformer s phase intro #f) intro)))

  ;; Call phase-1 function info, from syntax to syntax, on s in the current
  ;; compile-time store: a transformer, or a module pass, which may also
  ;; return a plain list (list-ok?). While it runs, the
  ;; expander queries answer for phase, blame s, and local-expand uses
  ;; intro, its introduction scope. Calls nest: a query can expand code,
  ;; which calls more macros.
  (define (call-syntax-function who info s phase intro list-ok?)
    (let* ([st (comp-store current)]
           [chunk (macro-entry st info)]
           [saved-phase api-phase] [saved-where api-where] [saved-intro api-intro])
      (dynamic-wind
        (lambda () (set! api-phase phase) (set! api-where s) (set! api-intro intro))
        (lambda ()
          (let* ([ms (cstore-marshal st)]
                 [mark (handle-mark ms)]
                 [in (encode ms s)]
                 [out (call-in-store st s (lambda (h) (host-call h chunk "__entry" in)))]
                 [result (decode ms out)])
            (handle-release! ms mark)
            (unless (or (stx? result) (and list-ok? (list? result)))
              (raise-compile-error s "~a returned a non-syntax value: ~s" who
                                   (if (wasm-value? result) '<object> (stx->datum result))))
            ;; [v0] Stage0 keeps syntax as Chez data, so it cannot keep a
            ;; GC object the syntax library does not represent (appendix A).
            (when (opaque-part result)
              (raise-compile-error s "~a returned syntax holding an object stage0 cannot keep (only syntax-library data can be kept in syntax and its properties)"
                                   who))
            result))
        (lambda () (set! api-phase saved-phase) (set! api-where saved-where) (set! api-intro saved-intro)))))

  ;; Run the module passes over forms, this module's expanded phase-0 code,
  ;; in order (spec 6.5). A pass gets the forms as one syntax list and
  ;; returns a list of forms, which are expanded again: a definition there
  ;; replaces this module's definition of the same name. Each pass has an
  ;; introduction scope, as a macro does, so the names it introduces cannot
  ;; capture the module's.
  (define (apply-module-passes c forms)
    (fold-left
     (lambda (forms pass)
       (let* ([intro (new-scope!)]
              [where (cdr pass)]
              [result (flip-scope (call-syntax-function "the module pass" (car pass)
                                                        (flip-scope (out-list where forms) intro) 0 intro #t)
                                  intro)]
              [new (or (stx->list result)
                       (raise-compile-error where "the module pass returned something other than a list of forms"))])
         (dynamic-wind
           (lambda () (set! redefining? #t))
           (lambda () (expand-body new 0))
           (lambda () (set! redefining? #f)))))
     forms
     (comp-passes c)))

  ;; An object inside syntax x (its datum or its properties) with no Chez
  ;; counterpart, or #f.
  (define (opaque-part x)
    (cond [(wasm-value? x) x]
          [(stx? x) (or (opaque-part (stx-e x)) (opaque-part (stx-props x)))]
          [(pair? x) (or (opaque-part (car x)) (opaque-part (cdr x)))]
          [else #f]))

  ;; Entry point for wasm calls to the expander queries. Arguments and results
  ;; are handles. Must never raise: an exception here would unwind through C
  ;; and wasm frames.
  (define (expander-callback op a b)
    (let ([st (and current (comp-store current))])
      (guard (c [#t (set! api-error
                          (if (compile-error? c)
                              c
                              (condition (make-error) (make-message-condition
                                                       (if (message-condition? c)
                                                           (condition-message c)
                                                           (format "~s" c))))))
                    (when st (host-request-trap! (cstore-host st) "expander query failed"))
                    0])
        (unless st (raise-compile-error #f "an expander query ran outside expansion"))
        (let ([ms (cstore-marshal st)])
          (case op
            [(1)                        ; syntax-local-value
             (let ([id (decode ms a)])
               (let ([m (and (id? id) (meaning-of id api-phase))])
                 (if (and m (eq? (car m) 'static))
                     (or (hashtable-ref (cstore-statics st) (cadr m) #f)
                         (raise-compile-error api-where "internal: static value of ~a not prepared" (stx-e id)))
                     0)))]
            [(2)                        ; syntax-error
             (let ([s (decode ms a)] [msg (decode ms b)])
               (raise-compile-error (if (and (stx? s) (stx-srcloc s)) s api-where) "~a~a"
                                    (if (string? msg) msg (format "~s" msg))
                                    (if (stx? s) (format "\n  in: ~s" (stx->datum s)) "")))]
            [(3)                        ; free-identifier=?
             (let ([x (decode ms a)] [y (decode ms b)])
               (unless (and (id? x) (id? y)) (raise-compile-error api-where "free-identifier=?: expected identifiers"))
               ;; Same meaning, so an import and what it imports are equal.
               (let ([mx (meaning-of x api-phase)] [my (meaning-of y api-phase)])
                 (if (if (or mx my) (equal? mx my) (eq? (stx-e x) (stx-e y))) 1 0)))]
            [(4)                        ; binding-kind
             (let ([id (decode ms a)])
               (unless (id? id) (raise-compile-error api-where "binding-kind: expected an identifier"))
               (let ([m (meaning-of id api-phase)])
                 (encode ms (case (and m (car m))
                              [(func) 'function]
                              [(local global) 'variable]
                              [(macro) 'macro]
                              [(static) 'static]
                              [(data) 'data]
                              [(label) 'label]
                              [(core prim) 'core]
                              [else #f]))))]
            [(5)                        ; local-expand
             ;; As in Racket, the running macro's introduction scope is
             ;; flipped around the expansion, so code from the macro's input
             ;; expands as it would at the use site.
             (let ([s (decode ms a)])
               (unless (and (stx? s) (not (opaque-part s)))
                 (raise-compile-error api-where "local-expand: expected syntax"))
               (encode ms (flip-scope (expand-expr (flip-scope s api-intro) api-phase) api-intro)))]
            [(6)                        ; lift-definition
             ;; The form gets the macro's introduction scope, as its output
             ;; does. The macro gets back the form as it is declared.
             (let ([form (decode ms a)])
               (unless (and (stx? form) (not (opaque-part form)))
                 (raise-compile-error api-where "lift-definition: expected syntax"))
               (let ([introduced (flip-scope form api-intro)])
                 (lift! introduced api-where api-phase)
                 (encode ms introduced)))]
            [else (raise-compile-error api-where "unknown expander query ~a" op)])))))

  ;; ==== expanded code =================================================================
  ;;
  ;; Expansion turns code into expanded code (spec 6.4): syntax in the
  ;; kernel's core grammar, with every macro use expanded and every
  ;; application and literal explicit. Lowering (below) turns expanded code
  ;; into the compiler's input (core.sls).
  ;;
  ;; The core forms in expanded code are named by identifiers with only the
  ;; core scope, so they mean the core forms in any module, whatever it
  ;; binds. Everything else keeps its scopes. So expanded code can be
  ;; expanded again: macros can embed the result of local-expand, and a
  ;; module pass returns expanded code.

  ;; The identifier for core form `name` in expanded code.
  (define (core-id name where) (make-stx name (list core-scope) (and where (stx-srcloc where)) '()))

  ;; A list in expanded code, located at where.
  (define (out-list where items) (make-stx items (list core-scope) (and where (stx-srcloc where)) '()))

  ;; The core form (name part ...), located at where.
  (define (out where name . parts) (out-list where (cons (core-id name where) parts)))

  ;; Module-level form f with its head replaced by the core identifier.
  (define (core-headed f name) (out-list f (cons (core-id name (car (stx-e f))) (cdr (stx-e f)))))

  ;; An identifier for one of the syntax library's functions, for the calls
  ;; quasiquote and quasisyntax expand into. Its private scope is on no
  ;; module's code, so only expanded code can refer to it.
  (define syntax-lib-scope #f)
  (define syntax-lib-ids (make-eq-hashtable))
  (define (syntax-lib-id name)
    (unless syntax-lib-scope (set! syntax-lib-scope (new-scope!)))
    (or (hashtable-ref syntax-lib-ids name #f)
        (let ([id (make-stx name (list syntax-lib-scope) #f '())])
          (bind-raw! name (list syntax-lib-scope) 'all (list 'func (syntax-info name)))
          (hashtable-set! syntax-lib-ids name id)
          id)))

  ;; ==== expressions ===================================================================

  ;; s has no value binding. It may still name a type.
  (define (unbound s sym phase)
    (if (type-meaning-of s phase)
        (raise-compile-error s "~a is a type, not a value" sym)
        (raise-compile-error s "unbound identifier ~a~a" sym (if (> phase 0) (format " at phase ~a" phase) ""))))

  (define (expand-expr s phase)
    (let ([e (stx-e s)])
      (cond
        [(symbol? e)
         (let ([m (meaning-of s phase)])
           (case (and m (car m))
             [(local global) s]
             [(macro) (expand-expr (apply-macro s (cadr m) s phase #f) phase)]
             [(static) (raise-compile-error s "~a is static information: read it with syntax-local-value" e)]
             [(func) (raise-compile-error s "~a is a function: call it, or use (func-index ~a)" e e)]
             [(data) (raise-compile-error s "~a is data: use (data-address ~a) and (data-size ~a)" e e e)]
             [(core prim) (raise-compile-error s "bad use of ~a" e)]
             [(label) (raise-compile-error s "~a is a label" e)]
             [else (unbound s e phase)]))]
        [(pair? e)
         (let* ([head (car e)]
                [m (and (id? head) (meaning-of head phase))])
           (case (and m (car m))
             [(core) (expand-core (cadr m) s phase)]
             [(macro) (expand-expr (apply-macro head (cadr m) s phase #f) phase)]
             [(prim) (expand-prim (cadr m) s phase)]
             [else
              ;; Any other form is an application: (#%app f arg ...), where
              ;; #%app has the scopes of the form (spec 5.3).
              (when (and (id? head) (eq? (stx-e head) app-sym))
                (if m
                    (raise-compile-error s "#%app is bound here, but not to a macro or the core form")
                    (unbound head app-sym phase)))
              (expand-expr (stx-rewrap s (cons (implicit-id s app-sym) e)) phase)]))]
        [(null? e) (raise-compile-error s "empty form ()")]
        [(literal? e)
         ;; A literal is (#%datum literal), where #%datum has the scopes of
         ;; the literal (spec 5.4).
         (let* ([id (implicit-id s datum-sym)]
                [m (meaning-of id phase)])
           (case (and m (car m))
             [(core) (core-datum s) (out s datum-sym s)]
             [(macro) (expand-expr (apply-macro id (cadr m) (stx-rewrap s (list id s)) phase #f) phase)]
             [else (raise-compile-error s "the literal ~s needs #%datum, which is ~a here" (stx->datum s)
                                        (if m "not a macro or the core form" "unbound"))]))]
        [else (raise-compile-error s "~s is not an expression" (stx->datum s))])))

  (define (literal? e)
    (or (and (integer? e) (exact? e)) (flonum? e) (char? e) (boolean? e) (string? e)))

  ;; The identifier `name` with the scopes and srcloc of s: the implicit
  ;; #%app of a form or #%datum of a literal.
  (define (implicit-id s name) (datum->stx s name (stx-srcloc s)))

  ;; The core #%datum: an unquoted literal is a wasm number (spec 5.4).
  ;; Checks the literal, and gives its lowered form.
  (define (core-datum s)
    (let ([e (stx-e s)])
      (cond [(and (integer? e) (exact? e)) (list 'int e)]
            [(flonum? e) (list 'float e)]
            [(char? e) (list 'int (char->integer e))]
            [(eq? e #t) '(const i32 1)]
            [(eq? e #f) '(const i32 0)]
            [(string? e)
             (raise-compile-error s "a string is not a wasm value: use (data name offset \"...\") for bytes, or '\"...\" for a syntax-library string")]
            [else (raise-compile-error s "~s is not a literal" (stx->datum s))])))

  ;; The core #%app: (#%app f arg ...) calls the function f.
  (define (core-app s parts phase)
    (let* ([f (cadr parts)]
           [m (and (id? f) (meaning-of f phase))])
      (case (and m (car m))
        [(func) (apply out s app-sym f (map-lr (lambda (a) (expand-expr a phase)) (cddr parts)))]
        [(local global) (raise-compile-error s "~a is a variable, not a function" (stx-e f))]
        [(static data label core prim macro)
         (raise-compile-error s "~a is not a function" (stx-e f))]
        [else (if (id? f)
                  (unbound f (stx-e f) phase)
                  (raise-compile-error s "a function call needs a function name, got ~s" (stx->datum f)))])))

  ;; A numeric or memory instruction: its arguments, and a trailing literal
  ;; offset if it has one.
  (define (prim-args name s)
    (let* ([p (lookup-prim name)]
           [args (or (stx->list (cdr (stx-e s))) (raise-compile-error s "bad syntax"))]
           [n (length (prim-op-params p))])
      (cond [(= (length args) n) (values args #f)]
            [(and (eq? (prim-op-kind p) 'mem) (= (length args) (+ n 1))
                  (let ([off (stx-e (list-ref args n))]) (and (fixnum? off) (>= off 0))))
             (values (list-head args n) (list-ref args n))]
            [else (raise-compile-error s "~a takes ~a argument~a~a, got ~a" name n (if (= n 1) "" "s")
                                       (if (eq? (prim-op-kind p) 'mem) " and an optional offset" "")
                                       (length args))])))

  (define (expand-prim name s phase)
    (let-values ([(args offset) (prim-args name s)])
      (apply out s name (append (map-lr (lambda (a) (expand-expr a phase)) args)
                                (if offset (list offset) '())))))

  (define (data-info-of id phase)
    (let ([m (and (id? id) (meaning-of id phase))])
      (unless (and m (eq? (car m) 'data))
        (raise-compile-error id "~s is not data" (stx->datum id)))
      (cadr m)))

  ;; GC forms: (op immediate ... arg ...). Immediates are types, fields and
  ;; reference types. Checks the form and returns its resolved immediates
  ;; and its argument forms.
  (define (gc-parts name parts phase)
    (define (arity n) (unless (= (length parts) n) (raise-compile-error (car parts) "bad ~a syntax" name)))
    (define args (cdr parts))
    (case name
      [(struct.new array.new_fixed)
       (unless (>= (length args) 1) (raise-compile-error (car parts) "bad ~a syntax" name))
       (let ([t (type-of (car args) phase)])
         (unless (eq? (type-info-kind t) (if (eq? name 'struct.new) 'struct 'array))
           (raise-compile-error (car args) "~a is not a~a type" (type-info-name t)
                                (if (eq? name 'struct.new) " struct" "n array")))
         (values (list t) (cdr args)))]
      [(struct.get struct.get_s struct.get_u)
       (arity 4)
       (let ([t (type-of (car args) phase)])
         (values (list t (field-index t (cadr args))) (list (caddr args))))]
      [(struct.set)
       (arity 5)
       (let ([t (type-of (car args) phase)])
         (values (list t (field-index t (cadr args))) (list (caddr args) (cadddr args))))]
      [(array.new array.new_default array.get array.get_s array.get_u array.set array.fill)
       (arity (+ 2 (case name [(array.new_default) 1] [(array.new array.get array.get_s array.get_u) 2]
                     [(array.set) 3] [(array.fill) 4])))
       (let ([t (type-of (car args) phase)])
         (unless (eq? (type-info-kind t) 'array)
           (raise-compile-error (car args) "~a is not an array type" (type-info-name t)))
         (values (list t) (cdr args)))]
      [(array.copy)
       (arity 8)
       (values (list (type-of (car args) phase) (type-of (cadr args) phase)) (cddr args))]
      [(ref.null)
       (arity 2)
       (values (list (parse-heap (car args) phase)) '())]
      [(ref.test ref.cast)
       (arity 3)
       (values (list (parse-reftype (car args) phase)) (list (cadr args)))]
      [(ref.eq) (arity 3) (values '() args)]
      [(array.len ref.is_null ref.as_non_null ref.i31 i31.get_s i31.get_u)
       (arity 2)
       (values '() (list (car args)))]
      [else (raise-compile-error (car parts) "internal: unknown GC form ~a" name)]))

  ;; parts of GC form (name immediate ... arg ...) with the type immediates
  ;; expanded (spec 5.1).
  (define (expand-gc-immediates name parts phase)
    (let ([n (case name
               [(ref.null ref.test ref.cast) 1]
               [(array.copy) 2]
               [(ref.eq array.len ref.is_null ref.as_non_null ref.i31 i31.get_s i31.get_u) 0]
               [else 1])])
      (if (< (length parts) (+ n 1))
          parts
          (cons (car parts)
                (append (map-lr (lambda (t) (if (memq name '(ref.test ref.cast))
                                                (expand-type t phase)
                                                (expand-type-name t phase)))
                                (list-head (cdr parts) n))
                        (list-tail (cdr parts) n))))))

  (define (expand-gc name s parts0 phase)
    (let*-values ([(parts) (expand-gc-immediates name parts0 phase)]
                  [(imms args) (gc-parts name parts phase)])
      (apply out s name (append (list-head (cdr parts) (- (length (cdr parts)) (length args)))
                                (map-lr (lambda (a) (expand-expr a phase)) args)))))

  (define (expand-core name s phase)
    (let ([parts (or (stx->list s) (raise-compile-error s "bad ~a syntax" name))])
      (define (arity-check ok?)
        (unless ok? (raise-compile-error s "bad ~a syntax" name)))
      (define (ex x) (expand-expr x phase))
      (define (o . parts) (apply out s name parts))
      (cond
        [(eq? name app-sym)
         (arity-check (>= (length parts) 2))
         (core-app s parts phase)]
        [(eq? name datum-sym)
         (arity-check (= (length parts) 2))
         (core-datum (cadr parts))
         (o (cadr parts))]
        [else
         (case name
           [(quote)
            (arity-check (= (length parts) 2))
            (o (cadr parts))]
           [(quote-syntax)
            (arity-check (= (length parts) 2))
            (o (prune-local-scopes (cadr parts)))]
           [(quasiquote)
            (arity-check (= (length parts) 2))
            (quasi s (cadr parts) 0 phase 'quasiquote 'unquote 'unquote-splicing #f)]
           [(quasisyntax)
            (arity-check (= (length parts) 2))
            (quasi s (cadr parts) 0 phase 'quasisyntax 'unsyntax 'unsyntax-splicing #t)]
           [(unquote unquote-splicing unsyntax unsyntax-splicing)
            (raise-compile-error s "~a is not inside a quasi form" name)]
           [(data-address data-size)
            (arity-check (= (length parts) 2))
            (data-info-of (cadr parts) phase)
            (o (cadr parts))]
           [(set!)
            (arity-check (and (= (length parts) 3) (id? (cadr parts))))
            (let ([m (meaning-of (cadr parts) phase)])
              (unless (and m (memq (car m) '(local global)))
                (raise-compile-error (cadr parts) "set!: ~a is not a variable" (stx-e (cadr parts)))))
            (o (cadr parts) (ex (caddr parts)))]
           [(let let*)
            (arity-check (>= (length parts) 2))
            (let ([bs (map-lr (lambda (b)
                                (let ([bp (stx->list b)])
                                  (unless (and bp (memv (length bp) '(2 3)) (id? (car bp)))
                                    (raise-compile-error b "expected [name init] or [name type init]"))
                                  (if (= (length bp) 3)
                                      (let ([t (expand-type (cadr bp) phase)])
                                        (parse-type t phase)
                                        (list (car bp) t (caddr bp)))
                                      bp)))
                              (or (stx->list (cadr parts)) (raise-compile-error s "bad bindings")))]
                  [body (cddr parts)])
              (if (eq? name 'let)
                  (let* ([inits (map-lr (lambda (bp) (ex (binding-init bp))) bs)]
                         [sc (new-local-scope!)]
                         [xs (map-lr (lambda (bp)
                                       (let ([x (add-scope (car bp) sc)]) (bind-local! x phase) x))
                                     bs)])
                    (apply o (out-list (cadr parts) (map-lr binding-out bs xs inits))
                           (map-lr (lambda (x) (ex (add-scope x sc))) body)))
                  (expand-let* s bs body phase)))]
           [(begin) (apply o (map-lr ex (cdr parts)))]
           [(if)
            (arity-check (memv (length parts) '(3 4)))
            (apply o (map-lr ex (cdr parts)))]
           [(block loop)
            (arity-check (and (>= (length parts) 2) (id? (cadr parts))))
            (let* ([sc (new-local-scope!)]
                   [label (add-scope (cadr parts) sc)])
              (fresh-label! label phase)
              (apply o label (map-lr (lambda (x) (ex (add-scope x sc))) (cddr parts))))]
           [(br)
            (arity-check (memv (length parts) '(2 3)))
            (label-key-of (cadr parts) phase)
            (apply o (cadr parts) (map-lr ex (cddr parts)))]
           [(br-if)
            (arity-check (= (length parts) 3))
            (label-key-of (cadr parts) phase)
            (o (cadr parts) (ex (caddr parts)))]
           [(return)
            (arity-check (memv (length parts) '(1 2)))
            (apply o (map-lr ex (cdr parts)))]
           [(call-indirect)
            (arity-check (>= (length parts) 3))
            (let ([sig (expand-signature (cadr parts) phase)])
              (parse-signature sig phase)
              (apply o sig (map-lr ex (cddr parts))))]
           [(func-index)
            (arity-check (and (= (length parts) 2) (id? (cadr parts))))
            (let ([m (meaning-of (cadr parts) phase)])
              (unless (and m (eq? (car m) 'func))
                (raise-compile-error (cadr parts) "func-index: ~a is not a function" (stx-e (cadr parts)))))
            (o (cadr parts))]
           [(select)
            (arity-check (= (length parts) 4))
            (apply o (map-lr ex (cdr parts)))]
           [(drop)
            (arity-check (= (length parts) 2))
            (o (ex (cadr parts)))]
           [(unreachable nop) (arity-check (= (length parts) 1)) (o)]
           [else
            (if (memq name gc-forms)
                (expand-gc name s parts phase)
                (raise-compile-error s "~a is only allowed at module level" name))])])))

  ;; A let binding [x init] or [x type init].
  (define (binding-init bp) (if (= (length bp) 3) (caddr bp) (cadr bp)))
  (define (binding-out bp x init)
    (out-list (car bp) (if (= (length bp) 3) (list x (cadr bp) init) (list x init))))

  ;; (let* (b ...) body ...) as nested lets, one binding each.
  (define (expand-let* s bs body phase)
    (define (ex x) (expand-expr x phase))
    (if (null? bs)
        (apply out s 'let (out-list s '()) (map-lr ex body))
        (let* ([bp (car bs)]
               [init (ex (binding-init bp))]
               [sc (new-local-scope!)]
               [x (add-scope (car bp) sc)])
          (bind-local! x phase)
          (let ([later (map-lr (lambda (bp) (map-lr (lambda (y) (add-scope y sc)) bp)) (cdr bs))]
                [body (map-lr (lambda (y) (add-scope y sc)) body)])
            (apply out s 'let (out-list s (list (binding-out bp x init)))
                   (if (null? later)
                       (map-lr ex body)
                       (list (expand-let* s later body phase))))))))

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
  ;; One walker for both. The result is expanded code that calls the syntax
  ;; library. For quasisyntax, unchanged subtemplates become syntax
  ;; constants and changed lists are rewrapped with the template's own
  ;; scopes and srcloc (syntax-rewrap).

  (define (quasi where t depth phase qname uname sname syntax?)
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
    (define (call name . args) (apply out where app-sym (syntax-lib-id name) args))
    (define (constant x)
      (if syntax?
          (out x 'quote-syntax (prune-local-scopes x))
          (out x 'quote x)))
    ;; Rebuild the pair chain e (elements of template x) as an expression.
    (define (build-list x e depth)
      (let loop ([e e])
        (cond [(null? e) (out x 'quote (make-stx '() '() #f '()))]
              [(stx? e) (walk e depth)]
              [(and (= depth 0) (tagged? (car e) sname))
               (let ([v (expand-expr (cadr (stx->list (car e))) phase)])
                 (call 'append (if syntax? (call 'splice-list v) v) (loop (cdr e))))]
              [else (call 'cons (walk (car e) depth) (loop (cdr e)))])))
    (define (walk x depth)
      (cond [(not (changes? x depth)) (constant x)]
            [(and (tagged? x uname) (= depth 0)) (expand-expr (cadr (stx->list x)) phase)]
            [(pair? (stx-e x))
             (let* ([l (stx-e x)]
                    [inner-depth (cond [(or (tagged? x uname) (tagged? x sname)) (- depth 1)]
                                       [(tagged? x qname) (+ depth 1)]
                                       [else depth])]
                    [head (if (or (tagged? x uname) (tagged? x sname) (tagged? x qname))
                              (call 'cons (constant (car l)) (build-list x (cdr l) inner-depth))
                              (build-list x l depth))])
               (if syntax? (call 'syntax-rewrap (constant x) head) head))]
            [else (constant x)]))
    (walk t depth))

  ;; ==== lowering ===================================================================
  ;;
  ;; Expanded code -> the compiler's input (core.sls). Lowering only
  ;; resolves names: expansion has already checked the code and bound every
  ;; variable and label, so anything else is an internal error.

  (define (at s ast) (list 'at (stx-srcloc s) ast))

  (define (not-expanded s)
    (raise-compile-error s "internal: not expanded code: ~s" (stx->datum s)))

  (define (lower-forms forms phase)
    (filter values (map-lr (lambda (f) (lower-form f phase)) forms)))

  ;; A module-level form, or #f for one that needs no code (import).
  (define (lower-form f phase)
    (let ([parts (stx->list f)])
      (case (core-head f phase)
        [(func)
         (let* ([head (stx->list (cadr parts))]
                [info (func-info-of (car head) phase)])
           (let-values ([(results body) (parse-results (cddr parts) phase)])
             (list 'func info
                   (map-lr (lambda (p t) (cons (local-key-of (car (stx->list p)) phase) t))
                           (cdr head) (func-info-params info))
                   (lower-seq body f phase))))]
        [(global)
         (let ([m (meaning-of (cadr parts) phase)])
           (list 'global (cadr m) (lower-expr (cadddr parts) phase)))]
        [(import) #f]
        [(type) (list 'type (type-of (cadr parts) phase))]
        [(data) (list 'data (data-info-of (cadr parts) phase))]
        [else (list 'expr (lower-expr f phase))])))

  (define (lower-seq forms where phase)
    (at where (cons 'seq (map-lr (lambda (f) (lower-expr f phase)) forms))))

  (define (func-info-of id phase)
    (let ([m (and (id? id) (meaning-of id phase))])
      (unless (and m (eq? (car m) 'func)) (not-expanded id))
      (check-not-removed (cadr m) id)
      (cadr m)))

  (define (lowered-data-info id phase)
    (let ([info (data-info-of id phase)])
      (check-not-removed info id)
      info))

  ;; While lowering a module's phase-0 code: the infos of its definitions
  ;; that its module passes removed, which its code must not use.
  (define removed-definitions (make-parameter #f))

  (define (check-not-removed info id)
    (let ([removed (removed-definitions)])
      (when (and removed (hashtable-contains? removed info))
        (raise-compile-error id "~a is used, but a module pass removed its definition" (stx-e id)))))

  ;; The infos of c's phase-0 definitions (functions, imports, globals,
  ;; data) that forms, its code after the module passes, no longer defines.
  (define (definitions-removed c forms)
    (let ([kept (make-eq-hashtable)] [removed (make-eq-hashtable)])
      (for-each (lambda (f)
                  (let ([parts (stx->list f)])
                    (case (core-head f 0)
                      [(func) (hashtable-set! kept (cadr (meaning-of (car (stx->list (cadr parts))) 0)) #t)]
                      [(import global data) (hashtable-set! kept (cadr (meaning-of (cadr parts) 0)) #t)]
                      [else (void)])))
                forms)
      (for-each (lambda (key)
                  (let ([m (hashtable-ref meanings key #f)])
                    (when (and m (memq (car m) '(func global data)) (not (hashtable-contains? kept (cadr m))))
                      (hashtable-set! removed (cadr m) #t))))
                (comp-definition-keys c))
      removed))

  (define (local-key-of id phase)
    (let ([m (and (id? id) (meaning-of id phase))])
      (unless (and m (eq? (car m) 'local)) (not-expanded id))
      (cadr m)))

  (define (lower-expr s phase)
    (let ([e (stx-e s)])
      (at s
          (cond
            [(symbol? e)
             (let ([m (meaning-of s phase)])
               (case (and m (car m))
                 [(local) (list 'lref (cadr m))]
                 [(global) (check-not-removed (cadr m) s) (list 'gref (cadr m))]
                 [else (not-expanded s)]))]
            [(pair? e)
             (let* ([parts (stx->list s)]
                    [m (and parts (id? (car parts)) (meaning-of (car parts) phase))])
               (case (and m (car m))
                 [(core) (lower-core (cadr m) s parts phase)]
                 [(prim)
                  (let-values ([(args offset) (prim-args (cadr m) s)])
                    (list 'prim (cadr m) (and offset (stx-e offset))
                          (map-lr (lambda (a) (lower-expr a phase)) args)))]
                 [else (not-expanded s)]))]
            [else (not-expanded s)]))))

  (define (lower-core name s parts phase)
    (define (lo x) (lower-expr x phase))
    (cond
      [(eq? name app-sym) (list 'call (func-info-of (cadr parts) phase) (map-lr lo (cddr parts)))]
      [(eq? name datum-sym) (core-datum (cadr parts))]
      [else
       (case name
         [(quote) (list 'quote (stx->datum (cadr parts)))]
         [(quote-syntax) (list 'quote (cadr parts))]
         [(data-address) (list 'const 'i32 (data-info-offset (lowered-data-info (cadr parts) phase)))]
         [(data-size) (list 'const 'i32 (bytevector-length (data-info-bytes (lowered-data-info (cadr parts) phase))))]
         [(set!)
          (let ([m (meaning-of (cadr parts) phase)])
            (case (and m (car m))
              [(local) (list 'lset (cadr m) (lo (caddr parts)))]
              [(global) (check-not-removed (cadr m) (cadr parts)) (list 'gset (cadr m) (lo (caddr parts)))]
              [else (not-expanded s)]))]
         [(let)
          (list 'let
                (map-lr (lambda (b)
                          (let ([bp (stx->list b)])
                            (list (local-key-of (car bp) phase)
                                  (and (= (length bp) 3) (parse-type (cadr bp) phase))
                                  (lo (binding-init bp)))))
                        (stx->list (cadr parts)))
                (lower-seq (cddr parts) s phase))]
         [(begin) (cons 'seq (map-lr lo (cdr parts)))]
         [(if) (list 'if (lo (cadr parts)) (lo (caddr parts)) (and (= (length parts) 4) (lo (cadddr parts))))]
         [(block loop) (list name (label-key-of (cadr parts) phase) (lower-seq (cddr parts) s phase))]
         [(br) (list 'br (label-key-of (cadr parts) phase) (and (= (length parts) 3) (lo (caddr parts))))]
         [(br-if) (list 'br-if (label-key-of (cadr parts) phase) (lo (caddr parts)))]
         [(return) (list 'return (and (= (length parts) 2) (lo (cadr parts))))]
         [(call-indirect)
          (let-values ([(params results) (parse-signature (cadr parts) phase)])
            (list 'call-indirect params results (lo (caddr parts)) (map-lr lo (cdddr parts))))]
         [(func-index) (list 'func-index (func-info-of (cadr parts) phase))]
         [(select) (list 'select (lo (cadr parts)) (lo (caddr parts)) (lo (cadddr parts)))]
         [(drop) (list 'drop (lo (cadr parts)))]
         [(unreachable) '(unreachable)]
         [(nop) '(nop)]
         [else
          (if (memq name gc-forms)
              (let-values ([(imms args) (gc-parts name parts phase)])
                (list 'gc name imms (map-lr lo args)))
              (not-expanded s))])]))
  )
