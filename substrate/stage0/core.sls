;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Records and types shared by the expander and the compiler.
;;
;; Fully expanded kernel code (the compiler's input) is made of lists:
;;
;;  module forms:
;;    (func info ((key . type) ...) body)   (global info init-or-#f)
;;    (memory pages)   (table size)   (data dinfo)   (type tinfo)   (expr e)
;;    (memory-import instance)   (table-import instance)
;;  expressions:
;;    (int n) (float x) (const type n)
;;    (lref key) (lset key e) (gref ginfo) (gset ginfo e)
;;    (let ((key type-or-#f init) ...) body)   (seq e ...)   (if c t e-or-#f)
;;    (block key body) (loop key body) (br key e-or-#f) (br-if key c) (return e-or-#f)
;;    (call finfo (arg ...))  (prim name offset-or-#f (arg ...))
;;    (call-indirect (param ...) (result ...) idx (arg ...))  (func-index finfo)
;;    (gc op (immediate ...) (arg ...))
;;    (select a b c) (drop e) (unreachable) (nop) (quote datum)
;;
;; Local and label keys are integers. Functions, globals, data and types are
;; referred to by their info records, which say which instance defines them.
;;
;; Value types are i32, i64, f32, f64, or (ref nullable? heap), where heap
;; is one of the abstract heap types (any eq i31 struct array func extern
;; none nofunc noextern) or a type-info.
(library (stage0 core)
  (export make-func-info func-info? func-info-name func-info-params func-info-results
          func-info-instance func-info-instance-set! func-info-export func-info-export-set!
          make-global-info global-info? global-info-name global-info-type
          global-info-instance global-info-instance-set! global-info-export global-info-export-set!
          make-data-info data-info? data-info-name data-info-offset data-info-bytes
          make-type-info type-info? type-info-name type-info-kind type-info-fields type-info-fields-set!
          ref-type? make-ref ref-nullable? ref-heap abstract-heaps numeric-type?
          valtype<=? types<=? valtype-join valtype->string unpacked defaultable?
          fresh-key! reset-keys!)
  (import (chezscheme))

  ;; instance: name of the instance that defines it, or #f while it is being
  ;; compiled. export: the export (or import field) name.
  (define-record-type func-info
    (fields name params results (mutable instance) (mutable export)))

  (define-record-type global-info
    (fields name type (mutable instance) (mutable export)))

  ;; An active data segment: bytes placed at offset in the module's memory.
  (define-record-type data-info (fields name offset bytes))

  ;; A declared GC type. kind is struct or array. A struct's fields are a
  ;; list of (name storage mutable?); an array's are one (storage mutable?).
  ;; storage is a value type, or i8 or i16.
  (define-record-type type-info (fields name kind (mutable fields)))

  ;; ---- value types ----------------------------------------------------------

  (define abstract-heaps '(any eq i31 struct array func extern none nofunc noextern))

  (define (numeric-type? t) (memq t '(i32 i64 f32 f64)))
  (define (ref-type? t) (and (pair? t) (eq? (car t) 'ref)))
  (define (make-ref nullable? heap) (list 'ref nullable? heap))
  (define (ref-nullable? t) (cadr t))
  (define (ref-heap t) (caddr t))

  (define (heap<=? a b)
    (cond [(eq? a b) #t]
          [(eq? a 'none) (or (type-info? b) (memq b '(any eq i31 struct array)))]
          [(eq? a 'nofunc) (eq? b 'func)]
          [(eq? a 'noextern) (eq? b 'extern)]
          [(memq a '(i31 struct array)) (memq b '(eq any))]
          [(eq? a 'eq) (eq? b 'any)]
          [(type-info? a)
           (or (memq b '(eq any))
               (eq? b (type-info-kind a)))]
          [else #f]))

  (define (valtype<=? a b)
    (cond [(and (ref-type? a) (ref-type? b))
           (and (or (not (ref-nullable? a)) (ref-nullable? b))
                (heap<=? (ref-heap a) (ref-heap b)))]
          [else (eq? a b)]))

  (define (types<=? as bs)
    (and (= (length as) (length bs)) (for-all valtype<=? as bs)))

  ;; The least type both a and b fit, or #f.
  (define (valtype-join a b)
    (cond [(valtype<=? a b) b]
          [(valtype<=? b a) a]
          [(and (ref-type? a) (ref-type? b))
           (let ([n (or (ref-nullable? a) (ref-nullable? b))])
             (cond [(and (heap<=? (ref-heap a) 'eq) (heap<=? (ref-heap b) 'eq)) (make-ref n 'eq)]
                   [(and (heap<=? (ref-heap a) 'any) (heap<=? (ref-heap b) 'any)) (make-ref n 'any)]
                   [else #f]))]
          [else #f]))

  (define (unpacked storage) (if (memq storage '(i8 i16)) 'i32 storage))

  ;; Can a local or global of this type start without an explicit value?
  (define (defaultable? t) (or (numeric-type? t) (and (ref-type? t) (ref-nullable? t))))

  (define (valtype->string t)
    (cond [(symbol? t) (symbol->string t)]
          [(ref-type? t)
           (let ([h (ref-heap t)])
             (if (and (ref-nullable? t) (memq h '(any eq i31 struct array func extern)))
                 (format "~aref" h)
                 (format "(ref ~a~a)" (if (ref-nullable? t) "null " "")
                         (if (type-info? h) (type-info-name h) h))))]
          [else (format "~a" t)]))

  (define key-counter 0)
  (define (reset-keys!) (set! key-counter 0))
  (define (fresh-key!) (set! key-counter (+ key-counter 1)) key-counter))
