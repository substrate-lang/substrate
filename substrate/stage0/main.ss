;; subc: the stage0 driver.
;;
;;   subc run FILE           compile FILE and run its main function
;;   subc compile FILE [-o OUT]   write FILE's phase-0 module
;;   subc expand FILE        print FILE's fully expanded kernel forms
;;   subc rt [-o OUT]        write the compiled rt module
(import (chezscheme) (stage0 syntax) (stage0 expander) (stage0 host))

(define root (or (getenv "SUBSTRATE_ROOT") "."))
(define rt-path (string-append root "/rt/rt.sub"))

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

(define (run-program sess bytes)
  (let ([h (host-new)])
    (host-instantiate! h "rt" (session-rt-bytes sess))
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
       (let ([sess (make-session rt-path)])
         (run-program sess (compile-source sess (cadr args))))]
      [(and (>= (length args) 2) (string=? (car args) "compile"))
       (let ([sess (make-session rt-path)])
         (write-file (option args "-o" (replace-extension (cadr args) ".wasm"))
                     (compile-source sess (cadr args))))]
      [(and (= (length args) 2) (string=? (car args) "expand"))
       (let ([sess (make-session rt-path)])
         (for-each (lambda (f) (pretty-print (strip-ast f))) (expand-source sess (cadr args))))]
      [(and (>= (length args) 1) (string=? (car args) "rt"))
       (let ([sess (make-session rt-path)])
         (write-file (option args "-o" "build/rt.wasm") (session-rt-bytes sess)))]
      [else (die 64 "usage: subc run FILE | compile FILE [-o OUT] | expand FILE | rt [-o OUT]")])
    (flush-output-port (current-output-port))))

(main (command-line-arguments))
