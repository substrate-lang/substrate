;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Binary wasm encoder. The compiler builds a module description and this
;; turns it into bytes; nothing here knows about the kernel language.
;;
;; Instructions are lists (op imm ...). Structured ones nest:
;;   (block bt instrs) (loop bt instrs) (if bt then-instrs else-instrs)
;; where bt is () | valtype | (type n).
;;
;; Value types are resolved: i32 i64 f32 f64, or (ref nullable? heap) where
;; heap is an abstract heap type symbol or a type index.
(library (stage0 wasm)
  (export make-wmodule encode-module)
  (import (chezscheme) (stage0 ops))

  ;; types:   list of (func (param ...) (result ...)) | (struct ((storage mut?) ...))
  ;;          | (array (storage mut?)) | (sub final? (supertypeidx ...) comptype)
  ;;          | (rec entry ...), a recursion group of sub or comptype entries;
  ;;          storage is a valtype, i8 or i16
  ;; imports: list of (module field kind desc); kind func: typeidx,
  ;;          memory/table: (min max-or-#f), global: (valtype mutable?)
  ;; funcs:   list of (typeidx locals instrs name)
  ;; tables, memories: list of (min max-or-#f)
  ;; globals: list of (valtype mutable? init-instrs)
  ;; exports: list of (name kind idx)
  ;; start:   funcidx or #f
  ;; declared: funcidxs referenced by ref.func (declarative elem segment)
  ;; datas:   list of (offset . bytevector): active segments in memory 0
  ;; names:   (module-name (funcidx . name) ...) for the name section, or #f
  (define-record-type wmodule
    (fields types imports funcs tables memories globals exports start declared datas names))

  ;; ---- byte output --------------------------------------------------------

  (define (out-byte! port b) (put-u8 port b))

  (define (uleb! port n)
    (let loop ([n n])
      (let ([b (logand n #x7F)] [rest (ash n -7)])
        (if (zero? rest)
            (out-byte! port b)
            (begin (out-byte! port (logior b #x80)) (loop rest))))))

  (define (sleb! port n)
    (let loop ([n n])
      (let ([b (logand n #x7F)] [rest (ash n -7)])
        (if (or (and (zero? rest) (zero? (logand b #x40)))
                (and (= rest -1) (not (zero? (logand b #x40)))))
            (out-byte! port b)
            (begin (out-byte! port (logior b #x80)) (loop rest))))))

  (define (bytes! port bv) (put-bytevector port bv))

  (define (name! port s)
    (let ([bv (string->utf8 s)])
      (uleb! port (bytevector-length bv))
      (bytes! port bv)))

  (define (with-output proc)
    (call-with-values open-bytevector-output-port
      (lambda (port extract) (proc port) (extract))))

  (define (vec! port items item!)
    (uleb! port (length items))
    (for-each (lambda (x) (item! port x)) items))

  (define (section! port id body-proc)
    (let ([body (with-output body-proc)])
      (out-byte! port id)
      (uleb! port (bytevector-length body))
      (bytes! port body)))

  ;; ---- types --------------------------------------------------------------

  (define (heap! port h)
    (if (integer? h)
        (sleb! port h)
        (out-byte! port
                   (case h
                     [(func) #x70] [(extern) #x6F] [(any) #x6E] [(eq) #x6D] [(i31) #x6C]
                     [(struct) #x6B] [(array) #x6A] [(none) #x71] [(noextern) #x72] [(nofunc) #x73]
                     [else (error 'encode "unknown heap type" h)]))))

  (define (valtype! port t)
    (cond [(pair? t)
           (out-byte! port (if (cadr t) #x63 #x64))
           (heap! port (caddr t))]
          [else
           (out-byte! port
                      (case t
                        [(i32) #x7F] [(i64) #x7E] [(f32) #x7D] [(f64) #x7C] [(v128) #x7B]
                        [(funcref) #x70] [(externref) #x6F]
                        [else (error 'encode "unknown value type" t)]))]))

  (define (storage! port s)
    (case s
      [(i8) (out-byte! port #x78)]
      [(i16) (out-byte! port #x77)]
      [else (valtype! port s)]))

  (define (field! port f)
    (storage! port (car f))
    (out-byte! port (if (cadr f) 1 0)))

  (define (limits! port lim)
    (let ([min (car lim)] [max (cadr lim)])
      (if max
          (begin (out-byte! port 1) (uleb! port min) (uleb! port max))
          (begin (out-byte! port 0) (uleb! port min)))))

  (define (blocktype! port bt)
    (cond [(null? bt) (out-byte! port #x40)]
          [(and (pair? bt) (eq? (car bt) 'type)) (sleb! port (cadr bt))]
          [else (valtype! port bt)]))

  ;; ---- instructions -------------------------------------------------------

  (define (instrs! port instrs) (for-each (lambda (i) (instr! port i)) instrs))

  (define (instr! port i)
    (let ([op (car i)] [args (cdr i)])
      (define (u n) (uleb! port n))
      (define (b n) (out-byte! port n))
      (define (gc n) (b #xFB) (u n))
      (case op
        [(unreachable) (b #x00)]
        [(nop) (b #x01)]
        [(block) (b #x02) (blocktype! port (car args)) (instrs! port (cadr args)) (b #x0B)]
        [(loop) (b #x03) (blocktype! port (car args)) (instrs! port (cadr args)) (b #x0B)]
        [(if) (b #x04) (blocktype! port (car args)) (instrs! port (cadr args))
              (unless (null? (caddr args)) (b #x05) (instrs! port (caddr args)))
              (b #x0B)]
        [(br) (b #x0C) (u (car args))]
        [(br_if) (b #x0D) (u (car args))]
        [(return) (b #x0F)]
        [(call) (b #x10) (u (car args))]
        [(call_indirect) (b #x11) (u (car args)) (u (cadr args))]
        [(return_call) (b #x12) (u (car args))]
        [(return_call_indirect) (b #x13) (u (car args)) (u (cadr args))]
        [(drop) (b #x1A)]
        [(select) (b #x1B)]
        [(select-typed) (b #x1C) (u 1) (valtype! port (car args))]
        [(local.get) (b #x20) (u (car args))]
        [(local.set) (b #x21) (u (car args))]
        [(local.tee) (b #x22) (u (car args))]
        [(global.get) (b #x23) (u (car args))]
        [(global.set) (b #x24) (u (car args))]
        [(i32.const) (b #x41) (sleb! port (car args))]
        [(i64.const) (b #x42) (sleb! port (car args))]
        [(f32.const) (b #x43)
         (let ([bv (make-bytevector 4)])
           (bytevector-ieee-single-set! bv 0 (car args) (endianness little))
           (bytes! port bv))]
        [(f64.const) (b #x44)
         (let ([bv (make-bytevector 8)])
           (bytevector-ieee-double-set! bv 0 (car args) (endianness little))
           (bytes! port bv))]
        [(ref.null) (b #xD0) (heap! port (car args))]
        [(ref.is_null) (b #xD1)]
        [(ref.func) (b #xD2) (u (car args))]
        [(ref.eq) (b #xD3)]
        [(ref.as_non_null) (b #xD4)]
        [(table.grow) (b #xFC) (u 15) (u (car args))]
        [(table.size) (b #xFC) (u 16) (u (car args))]
        ;; GC (0xFB prefix)
        [(struct.new) (gc 0) (u (car args))]
        [(struct.get) (gc 2) (u (car args)) (u (cadr args))]
        [(struct.get_s) (gc 3) (u (car args)) (u (cadr args))]
        [(struct.get_u) (gc 4) (u (car args)) (u (cadr args))]
        [(struct.set) (gc 5) (u (car args)) (u (cadr args))]
        [(array.new) (gc 6) (u (car args))]
        [(array.new_default) (gc 7) (u (car args))]
        [(array.new_fixed) (gc 8) (u (car args)) (u (cadr args))]
        [(array.get) (gc 11) (u (car args))]
        [(array.get_s) (gc 12) (u (car args))]
        [(array.get_u) (gc 13) (u (car args))]
        [(array.set) (gc 14) (u (car args))]
        [(array.len) (gc 15)]
        [(array.fill) (gc 16) (u (car args))]
        [(array.copy) (gc 17) (u (car args)) (u (cadr args))]
        ;; (ref.test nullable? heap) / (ref.cast nullable? heap)
        [(ref.test) (gc (if (car args) 21 20)) (heap! port (cadr args))]
        [(ref.cast) (gc (if (car args) 23 22)) (heap! port (cadr args))]
        [(ref.i31) (gc 28)]
        [(i31.get_s) (gc 29)]
        [(i31.get_u) (gc 30)]
        [else
         (let ([p (lookup-prim op)])
           (unless p (error 'encode "unknown instruction" i))
           (for-each b (prim-op-code p))
           (when (eq? (prim-op-kind p) 'mem)
             ;; args: (align offset)
             (u (car args))
             (u (cadr args))))])))

  ;; ---- module -------------------------------------------------------------

  (define (encode-module m)
    (with-output
     (lambda (port)
       (bytes! port #vu8(#x00 #x61 #x73 #x6D #x01 #x00 #x00 #x00))
       (let ([types (wmodule-types m)])
         (unless (null? types)
           (section! port 1
             (lambda (p)
               (vec! p types
                     (lambda (p t)
                       (let entry! ([t t])
                         (case (car t)
                           [(func) (out-byte! p #x60) (vec! p (cadr t) valtype!) (vec! p (caddr t) valtype!)]
                           [(struct) (out-byte! p #x5F) (vec! p (cadr t) field!)]
                           [(array) (out-byte! p #x5E) (field! p (cadr t))]
                           ;; A final type with no supertype is written as its
                           ;; comptype alone.
                           [(sub) (let ([final? (cadr t)] [supers (caddr t)])
                                    (unless (and final? (null? supers))
                                      (out-byte! p (if final? #x4F #x50))
                                      (vec! p supers (lambda (p i) (uleb! p i))))
                                    (entry! (cadddr t)))]
                           ;; A recursion group: one entry, but each member has
                           ;; its own type index.
                           [(rec) (out-byte! p #x4E) (vec! p (cdr t) (lambda (p m) (entry! m)))]
                           [else (error 'encode "unknown type" t)]))))))))
       (let ([imports (wmodule-imports m)])
         (unless (null? imports)
           (section! port 2
             (lambda (p)
               (vec! p imports
                     (lambda (p imp)
                       (name! p (car imp))
                       (name! p (cadr imp))
                       (let ([desc (cadddr imp)])
                         (case (caddr imp)
                           [(func) (out-byte! p 0) (uleb! p desc)]
                           [(table) (out-byte! p 1) (out-byte! p #x70) (limits! p desc)]
                           [(memory) (out-byte! p 2) (limits! p desc)]
                           [(global) (out-byte! p 3) (valtype! p (car desc))
                                     (out-byte! p (if (cadr desc) 1 0))]))))))))
       (let ([funcs (wmodule-funcs m)])
         (unless (null? funcs)
           (section! port 3 (lambda (p) (vec! p funcs (lambda (p f) (uleb! p (car f))))))))
       (let ([tables (wmodule-tables m)])
         (unless (null? tables)
           (section! port 4 (lambda (p) (vec! p tables (lambda (p t) (out-byte! p #x70) (limits! p t)))))))
       (let ([mems (wmodule-memories m)])
         (unless (null? mems)
           (section! port 5 (lambda (p) (vec! p mems limits!)))))
       (let ([globals (wmodule-globals m)])
         (unless (null? globals)
           (section! port 6
             (lambda (p)
               (vec! p globals
                     (lambda (p g)
                       (valtype! p (car g))
                       (out-byte! p (if (cadr g) 1 0))
                       (instrs! p (caddr g))
                       (out-byte! p #x0B)))))))
       (let ([exports (wmodule-exports m)])
         (unless (null? exports)
           (section! port 7
             (lambda (p)
               (vec! p exports
                     (lambda (p e)
                       (name! p (car e))
                       (out-byte! p (case (cadr e) [(func) 0] [(table) 1] [(memory) 2] [(global) 3]))
                       (uleb! p (caddr e))))))))
       (when (wmodule-start m)
         (section! port 8 (lambda (p) (uleb! p (wmodule-start m)))))
       (let ([declared (wmodule-declared m)])
         (unless (null? declared)
           (section! port 9
             (lambda (p)
               (uleb! p 1)
               (out-byte! p 3)          ; declarative, elemkind + funcidx vector
               (out-byte! p #x00)
               (vec! p declared uleb!)))))
       (let ([funcs (wmodule-funcs m)])
         (unless (null? funcs)
           (section! port 10
             (lambda (p)
               (vec! p funcs
                     (lambda (p f)
                       (let ([body (with-output
                                    (lambda (q)
                                      (let ([groups (group-locals (cadr f))])
                                        (vec! q groups
                                              (lambda (q g) (uleb! q (cdr g)) (valtype! q (car g)))))
                                      (instrs! q (caddr f))
                                      (out-byte! q #x0B)))])
                         (uleb! p (bytevector-length body))
                         (bytes! p body))))))))
       (let ([datas (wmodule-datas m)])
         (unless (null? datas)
           (section! port 11
             (lambda (p)
               (vec! p datas
                     (lambda (p d)
                       (out-byte! p 0)     ; active, memory 0
                       (instr! p (list 'i32.const (car d)))
                       (out-byte! p #x0B)
                       (uleb! p (bytevector-length (cdr d)))
                       (bytes! p (cdr d))))))))
       (let ([names (wmodule-names m)])
         (when names
           (section! port 0
             (lambda (p)
               (name! p "name")
               (let ([sub (with-output (lambda (q) (name! q (car names))))])
                 (out-byte! p 0)
                 (uleb! p (bytevector-length sub))
                 (bytes! p sub))
               (let ([sub (with-output (lambda (q) (vec! q (cdr names) (lambda (q n) (uleb! q (car n)) (name! q (cdr n))))))])
                 (out-byte! p 1)
                 (uleb! p (bytevector-length sub))
                 (bytes! p sub)))))))))

  ;; Run-length group consecutive equal local types: ((type . count) ...)
  (define (group-locals types)
    (let loop ([ts types] [acc '()])
      (cond [(null? ts) (reverse acc)]
            [(and (pair? acc) (equal? (caar acc) (car ts)))
             (loop (cdr ts) (cons (cons (caar acc) (+ 1 (cdar acc))) (cdr acc)))]
            [else (loop (cdr ts) (cons (cons (car ts) 1) acc))]))))
