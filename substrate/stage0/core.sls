;; Records shared by the expander and the compiler.
;;
;; Fully expanded kernel code (the compiler's input) is made of lists:
;;
;;  module forms:
;;    (func info ((key . type) ...) body)   (global info init-or-#f)
;;    (memory name min)   (table name min)  (expr e)
;;  expressions:
;;    (int n) (float x) (const type n)
;;    (lref key) (lset key e) (gref ginfo) (gset ginfo e)
;;    (let ((key type-or-#f init) ...) body)   (seq e ...)   (if c t e-or-#f)
;;    (block key body) (loop key body) (br key e-or-#f) (br-if key c) (return e-or-#f)
;;    (call finfo (arg ...))  (prim name offset-or-#f (arg ...))
;;    (call-indirect (param ...) (result ...) idx (arg ...))  (func-index finfo)
;;    (select a b c) (drop e) (unreachable) (nop) (quote datum)
;;
;; Local and label keys are integers. Functions and globals are referred to
;; by their info records, which say which instance defines them.
(library (stage0 core)
  (export make-func-info func-info? func-info-name func-info-params func-info-results
          func-info-instance func-info-instance-set! func-info-export func-info-export-set!
          make-global-info global-info? global-info-name global-info-type
          global-info-instance global-info-instance-set! global-info-export global-info-export-set!
          fresh-key! reset-keys!)
  (import (chezscheme))

  ;; instance: name of the instance that defines it, or #f while it is being
  ;; compiled. export: the export (or import field) name.
  (define-record-type func-info
    (fields name params results (mutable instance) (mutable export)))

  (define-record-type global-info
    (fields name type (mutable instance) (mutable export)))

  (define key-counter 0)
  (define (reset-keys!) (set! key-counter 0))
  (define (fresh-key!) (set! key-counter (+ key-counter 1)) key-counter))
