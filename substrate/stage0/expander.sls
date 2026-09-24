;; Expander: syntax objects -> fully expanded kernel forms (core.sls).
;;
;; Binding is by sets of scopes (spec 6.1). A module is a file; each of its
;; phases compiles to one wasm module, a part (spec 3.1). While a module is
;; expanded, its phase >= 1 code is compiled into chunks and run in that
;; module's compile-time store. A macro is a phase-1 function from syntax to
;; syntax (spec 2.1). Syntax objects are GC objects of the syntax library
;; (stage0/syntax.sub), which every compile-time store instantiates.
(library (stage0 expander)
  (export set-syntax-library-path! compile-module-file run-module module-part-list module-expanded-forms
          syntax-library-bytes strip-ast)
  (import (chezscheme) (stage0 syntax) (stage0 core) (stage0 ops) (stage0 compile)
          (stage0 host) (stage0 marshal) (stage0 reader))

  (define gc-forms
    '(struct.new struct.get struct.get_s struct.get_u struct.set
      array.new array.new_default array.new_fixed array.get array.get_s array.get_u array.set
      array.len array.copy array.fill
      ref.null ref.is_null ref.eq ref.as_non_null ref.test ref.cast ref.i31 i31.get_s i31.get_u))

  (define core-forms
    (append
     '(func global import memory table data type define-syntax define-static begin-for-syntax
       begin require provide runtime-free set! let let* if block loop br br-if return
       call-indirect func-index data-address data-size select drop unreachable nop
       quote quasiquote unquote unquote-splicing quote-syntax quasisyntax unsyntax unsyntax-splicing)
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

  ;; phase: an integer, or 'all
  (define-record-type binding (fields scopes phase key))

  ;; meaning: (core name) (prim name) (func info) (global info) (data info)
  ;;          (type info) (local key) (label key) (macro transformer-info)
  ;;          (static getter-info)

  ;; A compiled (or compiling) module. parts: phase -> part. requires: list
  ;; of (module . shift). provides: list of (symbol . meaning). entries: its
  ;; module-level bindings, as (symbol scopes phase key). scope: its module
  ;; scope.
  (define-record-type unit
    (fields path source name (mutable state) parts (mutable requires) (mutable provides)
            (mutable entries) (mutable expanded) (mutable scope)))

  ;; One phase of a module, compiled: bytes, the instance names it imports
  ;; from (relative to the module at shift 0), and whether it uses GC.
  (define-record-type part (fields bytes imports gc?))

  ;; One wasm store: a compile-time store (one per module compilation) or a
  ;; run-time store. instances: names instantiated in it. wrappers and
  ;; statics: per-store entry chunks and static-value handles.
  (define-record-type cstore
    (fields host marshal instances wrappers statics (mutable counter)))

  ;; The state of one module's compilation.
  (define-record-type comp
    (fields module store (mutable chunk-counter) (mutable syntax-phases) (mutable use-site-scopes)
            (mutable runtime-free-form) phase-forms memories tables (mutable provide-ids)))

  (define current #f)                      ; the comp being expanded

  (define (new-scope!) (set! scope-counter (+ scope-counter 1)) scope-counter)

  (define core-scope 0)

  ;; ---- the syntax library ----

  (define library-path #f)
  (define syntax-lib #f)                      ; (bytes . infos)
  (define (set-syntax-library-path! p) (set! library-path p))

  (define (ensure-library!)
    (unless syntax-lib
      (let* ([m (make-unit library-path library-path "syntax" 'compiling (make-eqv-hashtable) '() '() '() #f #f)]
             [c (make-comp m #f 0 '() '() #f (make-eqv-hashtable) (make-eqv-hashtable) (make-eqv-hashtable) '())])
        (with-comp c
          (lambda ()
            (parameterize ([current-syntax-infos #f])
              (let* ([forms (expand-module-body (read-file library-path))]
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
          ;; Syntax literals the part builds carry the module scope for this
          ;; shift (spec 6.1). The syntax library maps it while the part starts.
          (let ([shifted? (and (not (= t 0)) (unit-scope m))])
            (when shifted?
              (host-call (cstore-host st) "syntax" "%set-scope-shift" (unit-scope m) (module-scope-at m t)))
            (host-instantiate-shifted! (cstore-host st) name (part-bytes p) t)
            (when shifted?
              (host-call (cstore-host st) "syntax" "%set-scope-shift" -1 0)))
          (hashtable-set! (cstore-instances st) name #t)))))

  ;; ---- bindings ----

  (define (bind-raw! sym scopes phase meaning)
    (let ([key (fresh-key!)])
      (hashtable-update! bindings sym (lambda (l) (cons (make-binding scopes phase key) l)) '())
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
                           (not (equal? (hashtable-ref meanings (binding-key b) #f) meaning)))
                  (raise-compile-error id "duplicate definition of ~a" (stx-e id))))
              (hashtable-ref bindings (stx-e id) '())))

  ;; Bind a module-level definition. Use-site scopes come off the name, so
  ;; a definition a macro makes from its input is visible to the rest of
  ;; the module (spec 6.2). A second binding of the same name with the same
  ;; scopes at the same phase is an error.
  (define (bind-definition! id phase meaning)
    (let ([id (remove-scopes id (comp-use-site-scopes current))])
      (check-unbound! id phase meaning)
      (bind-module-level! (stx-e id) (stx-scopes id) phase meaning)))

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
                        (when (or (not (scopes-subset? (binding-scopes b) (binding-scopes best)))
                                  (and (not (eq? b best)) (equal? (binding-scopes b) (binding-scopes best))
                                       (not (equal? (hashtable-ref meanings (binding-key b) #f)
                                                    (hashtable-ref meanings (binding-key best) #f)))))
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
                                (make-global-info (global-info-name info) (global-info-type info)
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
              (let ([sc (new-scope!)]) (hashtable-set! shifted-scopes key sc) sc)))))

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
                [c (make-comp m (new-cstore #t) 0 '() '() #f
                              (make-eqv-hashtable) (make-eqv-hashtable) (make-eqv-hashtable) '())])
           (hashtable-set! registry path m)
           (hashtable-set! modules-by-name name m)
           (with-comp c
             (lambda ()
               (parameterize ([current-syntax-infos (cdr syntax-lib)])
                 (let ([forms (expand-module-body (read-file source))])
                   (add-phase-forms! 0 forms)
                   (unit-expanded-set! m forms)
                   (finish-module! c)))))
           m)])))

  ;; Expand a module body at phase 0; phase >= 1 code runs as it goes.
  (define (expand-module-body forms)
    (install-base!)
    (let ([msc (new-scope!)])
      (unit-scope-set! (comp-module current) msc)
      (expand-body (map-lr (lambda (f) (add-scope (add-scope f core-scope) msc)) forms) 0)))

  (define (add-phase-forms! phase forms)
    (let ([t (comp-phase-forms current)])
      (hashtable-set! t phase (append (reverse forms) (hashtable-ref t phase '())))))

  ;; The memory and table forms declared for phase (spec 3.3).
  (define (storage-forms phase)
    (let ([mem (hashtable-ref (comp-memories current) phase #f)]
          [tbl (hashtable-ref (comp-tables current) phase #f)])
      (append (if mem (list mem) '()) (if tbl (list tbl) '()))))

  ;; Compile each phase's part, resolve provides, check (runtime-free).
  (define (finish-module! c)
    (let ([m (comp-module c)])
      (unit-provides-set!
       m
       (map-lr (lambda (id)
                 (let ([meaning (meaning-of id 0)])
                   (unless (and meaning (memq (car meaning) '(func global macro static type data)))
                     (raise-compile-error id "cannot provide ~a: it is not a module-level binding" (stx-e id)))
                   (cons (stx-e id) meaning)))
               (reverse (comp-provide-ids c))))
      (let ([phases (list-sort < (let-values ([(ks vs) (hashtable-entries (comp-phase-forms c))])
                                   (let ([ps (vector->list ks)]) (if (memv 0 ps) ps (cons 0 ps)))))])
        (for-each (lambda (p)
                    (let ([forms (append (storage-forms p) (reverse (hashtable-ref (comp-phase-forms c) p '())))])
                      (let-values ([(bytes imports gc?) (compile-module forms (part-name m p 0))])
                        (hashtable-set! (unit-parts m) p (make-part bytes imports gc?)))))
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

  (define (expand-body forms phase)
    ;; Pass 1: find definitions, run compile-time forms, splice begins.
    (let loop ([forms forms] [pending '()])
      (if (pair? forms)
          (let* ([f (head-expand (car forms) phase)]
                 [rest (cdr forms)])
            (case (core-head f phase)
              [(begin) (loop (append (cdr (stx-list-of f 'begin)) rest) pending)]
              [(require) (require! f phase) (loop rest pending)]
              [(provide) (provide! f phase) (loop rest pending)]
              [(runtime-free) (runtime-free! f phase) (loop rest pending)]
              [(func) (loop rest (cons (declare-func f phase) pending))]
              [(global) (loop rest (cons (declare-global f phase) pending))]
              [(import) (declare-import f phase) (loop rest pending)]
              [(memory table) (declare-storage! f phase) (loop rest pending)]
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
          (bind-definition! (cadr parts) phase (list 'type info))
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
            (bind-definition! name phase (list 'func info))
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
        (bind-definition! (cadr parts) phase (list 'global info))
        (list 'global info (cadddr parts)))))

  ;; (import name "module" "field" (t ... -> r ...))
  (define (declare-import f phase)
    (let ([parts (stx-list-of f 'import)])
      (unless (and (= (length parts) 5) (id? (cadr parts))
                   (string? (stx-e (caddr parts))) (string? (stx-e (cadddr parts))))
        (raise-compile-error f "expected (import name \"module\" \"field\" (type ... -> type ...))"))
      (let-values ([(params results) (parse-signature (list-ref parts 4) phase)])
        (bind-definition! (cadr parts) phase
               (list 'func (make-func-info (stx-e (cadr parts)) params results
                                           (stx-e (caddr parts)) (stx-e (cadddr parts))))))))


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
        (list 'data info))))

  ;; ---- require, provide, storage ----

  ;; (require spec ...) where spec is "path", syntax, or (for-syntax spec ...).
  ;; A module required at phase p is shifted by p: its phase q is p + q here.
  (define (require! f phase)
    (for-each (lambda (spec) (require-spec! f spec phase)) (cdr (stx-list-of f 'require))))

  (define (require-spec! f spec phase)
    (let ([l (stx->list spec)])
      (cond [(core-name? spec 'syntax) (require-syntax! spec phase)]
            [(string? (stx-e spec)) (require-module! f spec phase)]
            [(and l (pair? l) (core-name? (car l) 'for-syntax))
             (for-each (lambda (s) (require-spec! f s (+ phase 1))) (cdr l))]
            [else (raise-compile-error spec "expected \"path\", syntax, or (for-syntax spec ...)")])))

  ;; Bind the syntax library's contract functions at phase (spec 2.3), with
  ;; the scopes of the `syntax` identifier.
  (define (require-syntax! spec phase)
    (unless (current-syntax-infos)
      (raise-compile-error spec "the syntax library cannot require itself"))
    (unless (memv phase (comp-syntax-phases current))
      (comp-syntax-phases-set! current (cons phase (comp-syntax-phases current)))
      (let-values ([(names infos) (hashtable-entries (current-syntax-infos))])
        ;; sorted, for deterministic keys
        (for-each (lambda (info)
                    (bind-module-level! (func-info-name info) (stx-scopes spec) phase (list 'func info)))
                  (list-sort (lambda (a b) (string<? (symbol->string (func-info-name a))
                                                      (symbol->string (func-info-name b))))
                             (filter (lambda (info) (not (internal-name? (func-info-name info))))
                                     (vector->list infos)))))))

  (define (require-syntax-for s name phase)
    (unless (memv phase (comp-syntax-phases current))
      (raise-compile-error s "~a builds syntax-library data: add (require ~a)" name
                           (if (> phase 0) "(for-syntax syntax)" "syntax"))))

  (define (module-path-of f spec)
    (let* ([loc (stx-srcloc f)]
           [dir (if loc (directory-of (symbol->string (srcloc-source loc))) "")]
           [given (stx-e spec)])
      (if (and (> (string-length given) 0) (char=? (string-ref given 0) #\/))
          given
          (string-append dir given))))

  ;; Compile the module if needed, bind what it provides at phase, and make
  ;; its own bindings resolvable for its macros.
  (define (require-module! f spec phase)
    (let* ([m (compile-module-file (module-path-of f spec))]
           [me (comp-module current)]
           [req (cons m phase)])
      (unless (member req (unit-requires me))
        (unit-requires-set! me (append (unit-requires me) (list req)))
        (for-each (lambda (p)
                    (let ([id (datum->stx spec (car p) (stx-srcloc spec))]
                          [meaning (shift-meaning (cdr p) phase)])
                      (check-unbound! id phase meaning)
                      (bind-module-level! (car p) (stx-scopes spec) phase meaning)))
                  (unit-provides m))
        (install-module-bindings! m phase)
        (prepare-statics! m phase))))

  ;; The module a string names, which must already be required at `shift`.
  (define (required-module f spec shift)
    (let* ([path (normalize-path (module-path-of f spec))]
           [m (hashtable-ref registry path #f)])
      (unless (and m (member (cons m shift) (unit-requires (comp-module current))))
        (raise-compile-error spec "~a must be required at this phase first" (stx-e spec)))
      m))

  ;; (provide id ...): the phase-0 bindings other modules get by requiring
  ;; this one.
  (define (provide! f phase)
    (unless (= phase 0) (raise-compile-error f "provide belongs at phase 0"))
    (let ([ids (cdr (stx-list-of f 'provide))])
      (for-each (lambda (id) (unless (id? id) (raise-compile-error id "provide takes identifiers"))) ids)
      (comp-provide-ids-set! current (append (reverse ids) (comp-provide-ids current)))))

  ;; (memory pages) or (memory from "path"), and likewise (table ...): the
  ;; module's memory or table at this phase (spec 3.3).
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
            (raise-compile-error f "v0 defines ~as at phase 0 only; at phase ~a use (~a from \"module\")"
                                 kind phase kind))
          (list kind (stx-e (cadr parts)))]
         [(and (= (length parts) 3) (core-name? (cadr parts) 'from) (string? (stx-e (caddr parts))))
          (let ([m (required-module f (caddr parts) phase)])
            (list (if (eq? kind 'memory) 'memory-import 'table-import) (part-name m 0 phase)))]
         [else (raise-compile-error f "expected (~a size) or (~a from \"module\")" kind kind)]))))

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
  ;; or a module required for-syntax.
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
          (bind-definition! (cadr parts) phase (list 'macro info))))))

  ;; (define-static name expr): name is bound to the value of expr at
  ;; phase+1. The value lives in a global of the phase+1 part, computed when
  ;; the part is instantiated; macros read it with syntax-local-value.
  (define (define-static! f phase)
    (let ([parts (stx-list-of f 'define-static)])
      (unless (and (= (length parts) 3) (id? (cadr parts)))
        (raise-compile-error f "expected (define-static name expr)"))
      (let* ([name (string->symbol (string-append "__static." (symbol->string (stx-e (cadr parts)))))]
             [rhs (expand-expr (caddr parts) (+ phase 1))]
             [global (make-global-info name eqref #f #f)]
             [getter (make-func-info name '() (list eqref) #f #f)])
        (run-chunk! (list (list 'global global rhs) (list 'func getter '() (list 'gref global)))
                    (+ phase 1) f)
        (static-handle (comp-store current) getter)
        (bind-definition! (cadr parts) phase (list 'static getter)))))

  ;; (begin-for-syntax form ...)
  (define (begin-for-syntax! f phase)
    (let ([forms (expand-body (cdr (stx-list-of f 'begin-for-syntax)) (+ phase 1))])
      (run-chunk! forms (+ phase 1) f)))

  ;; ==== macros ======================================================================

  ;; State the expander query callbacks read.
  (define api-phase 0)
  (define api-where #f)               ; the form the running macro was given
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
    (let* ([st (comp-store current)]
           [chunk (macro-entry st transformer)]
           [intro (new-scope!)]
           [s (flip-scope s intro)]
           [s (if use-site?
                  (let ([use (new-scope!)])
                    (comp-use-site-scopes-set! current (cons use (comp-use-site-scopes current)))
                    (add-scope s use))
                  s)]
           [saved-phase api-phase] [saved-where api-where])
      (dynamic-wind
        (lambda () (set! api-phase phase) (set! api-where s))
        (lambda ()
          (let* ([ms (cstore-marshal st)]
                 [mark (handle-mark ms)]
                 [in (encode ms s)]
                 [out (call-in-store st s (lambda (h) (host-call h chunk "__entry" in)))]
                 [result (decode ms out)])
            (handle-release! ms mark)
            (unless (stx? result)
              (raise-compile-error s "macro ~a returned a non-syntax value: ~s" (stx-e head)
                                   (if (wasm-value? result) '<object> (stx->datum result))))
            (flip-scope result intro)))
        (lambda () (set! api-phase saved-phase) (set! api-where saved-where)))))

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
               (let ([kx (resolve x api-phase)] [ky (resolve y api-phase)])
                 (if (if (or kx ky) (eqv? kx ky) (eq? (stx-e x) (stx-e y))) 1 0)))]
            [else (raise-compile-error api-where "unknown expander query ~a" op)])))))

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
             [(macro) (expand-expr (apply-macro s (cadr m) s phase #f) phase)]
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
               [(macro) (expand-expr (apply-macro head (cadr m) s phase #f) phase)]
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
