;; subc: the stage0 driver.
;;
;;   subc run FILE                 compile FILE (and what it requires), run its main
;;   subc compile FILE [-o OUT]    write FILE's parts: phase 0 to OUT, phase p
;;                                 to OUT with .phase<p>.wasm
;;   subc expand FILE              print FILE's fully expanded phase-0 forms
;;   subc syntax-library [-o OUT]  write the compiled syntax library
(import (chezscheme) (stage0 syntax) (stage0 expander) (stage0 host))

(define root (or (getenv "SUBSTRATE_ROOT") "."))
(set-syntax-library-path! (string-append root "/stage0/syntax.sub"))

(define (write-file path bv)
  (call-with-port (open-file-output-port path (file-options no-fail))
    (lambda (p) (put-bytevector p bv))))

(define (strip-extension path)
  (let loop ([i (- (string-length path) 1)])
    (cond [(< i 0) path]
          [(char=? (string-ref path i) #\.) (substring path 0 i)]
          [(char=? (string-ref path i) #\/) path]
          [else (loop (- i 1))])))

(define (option args flag default)
  (let ([m (member flag args)])
    (if (and m (pair? (cdr m))) (cadr m) default)))

(define (die code fmt . args)
  (flush-output-port (current-output-port))
  (apply fprintf (current-error-port) fmt args)
  (newline (current-error-port))
  (exit code))

(define (main args)
  (guard (c [(compile-error? c)
             (die 1 "~a: error: ~a" (format-srcloc (compile-error-srcloc c)) (compile-error-message c))]
            [(wasm-failure? c) (die 2 "error: ~a" (wasm-failure-message c))]
            [(error? c)
             (flush-output-port (current-output-port))
             (display-condition c (current-error-port))
             (newline (current-error-port))
             (exit 3)])
    (cond
      [(and (= (length args) 2) (string=? (car args) "run"))
       (run-module (compile-module-file (cadr args)))]
      [(and (>= (length args) 2) (string=? (car args) "compile"))
       (let* ([m (compile-module-file (cadr args))]
              [out (option args "-o" (string-append (strip-extension (cadr args)) ".wasm"))])
         (for-each (lambda (p)
                     (write-file (if (= (car p) 0)
                                     out
                                     (format "~a.phase~a.wasm" (strip-extension out) (car p)))
                                 (cdr p)))
                   (module-part-list m)))]
      [(and (= (length args) 2) (string=? (car args) "expand"))
       (for-each (lambda (f) (pretty-print (strip-ast f))) (module-expanded-forms (compile-module-file (cadr args))))]
      [(and (>= (length args) 1) (string=? (car args) "syntax-library"))
       (write-file (option args "-o" "build/syntax.wasm") (syntax-library-bytes))]
      [else (die 64 "usage: subc run FILE | compile FILE [-o OUT] | expand FILE | syntax-library [-o OUT]")])
    (flush-output-port (current-output-port))))

(main (command-line-arguments))
