;; subc: the stage0 driver.
;;
;;   subc run FILE                 compile FILE and run its main function
;;   subc compile FILE [-o OUT]    write FILE's phase-0 module
;;   subc expand FILE              print FILE's fully expanded kernel forms
;;   subc syntax-library [-o OUT]  write the compiled syntax library
(import (chezscheme) (stage0 syntax) (stage0 expander) (stage0 host))

(define root (or (getenv "SUBSTRATE_ROOT") "."))
(define library-path (string-append root "/stage0/syntax.sub"))

(define (write-file path bv)
  (call-with-port (open-file-output-port path (file-options no-fail))
    (lambda (p) (put-bytevector p bv))))

(define (replace-extension path ext)
  (let loop ([i (- (string-length path) 1)])
    (cond [(< i 0) (string-append path ext)]
          [(char=? (string-ref path i) #\.) (string-append (substring path 0 i) ext)]
          [(char=? (string-ref path i) #\/) (string-append path ext)]
          [else (loop (- i 1))])))

(define (option args flag default)
  (let ([m (member flag args)])
    (if (and m (pair? (cdr m))) (cadr m) default)))

(define (die code fmt . args)
  (flush-output-port (current-output-port))
  (apply fprintf (current-error-port) fmt args)
  (newline (current-error-port))
  (exit code))

;; Run a compiled program in a fresh store. The syntax library is loaded
;; only if the program imports it (spec 3.2).
(define (run-program sess bytes imports)
  (let ([h (host-new)])
    (when (member "syntax" imports)
      (host-instantiate! h "syntax" (session-library-bytes sess)))
    (host-instantiate! h "main" bytes)
    (guard (c [(and (wasm-failure? c)
                    (let ([m (wasm-failure-message c)])
                      (and (>= (string-length m) 17) (string=? (substring m 0 17) "call: no function"))))
               (void)])
      (host-call h "main" "main"))))

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
       (let ([sess (make-session library-path)])
         (let-values ([(bytes imports) (compile-source sess (cadr args))])
           (run-program sess bytes imports)))]
      [(and (>= (length args) 2) (string=? (car args) "compile"))
       (let ([sess (make-session library-path)])
         (let-values ([(bytes imports) (compile-source sess (cadr args))])
           (write-file (option args "-o" (replace-extension (cadr args) ".wasm")) bytes)))]
      [(and (= (length args) 2) (string=? (car args) "expand"))
       (let ([sess (make-session library-path)])
         (for-each (lambda (f) (pretty-print (strip-ast f))) (expand-source sess (cadr args))))]
      [(and (>= (length args) 1) (string=? (car args) "syntax-library"))
       (let ([sess (make-session library-path)])
         (write-file (option args "-o" "build/syntax.wasm") (session-library-bytes sess)))]
      [else (die 64 "usage: subc run FILE | compile FILE [-o OUT] | expand FILE | syntax-library [-o OUT]")])
    (flush-output-port (current-output-port))))

(main (command-line-arguments))
