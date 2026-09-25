;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; subc: the stage0 driver.
;;
;;   subc run FILE [ARG ...]       compile FILE (and what it requires), run its main
;;                                 with the arguments
;;   subc build FILE [-o DIR]      write FILE's program to DIR, for build/subhost:
;;                                 each linklet it instantiates at run time, as
;;                                 DIR/<name>.wasm, and DIR/program, their names in
;;                                 the order they are instantiated (spec 4)
;;   subc compile FILE [-o OUT]    write FILE's linklets: phase 0 to OUT, phase p
;;                                 to OUT with .phase<p>.wasm
;;   subc expand FILE              print FILE's fully expanded phase-0 forms
;;   subc read FILE                print what the reader reads from FILE, to compare
;;                                 readers
;;   subc syntax-library [-o OUT]  write the compiled syntax library
(import (chezscheme) (stage0 syntax) (stage0 expander) (stage0 host) (stage0 reader))

(define root (or (getenv "SUBSTRATE_ROOT") "."))
(set-syntax-library-root! root)

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

;; Forms are written as the reader reads them. Chez escapes the # of a
;; symbol such as #%app, since its own reader gives #% another meaning;
;; with extended identifiers on, it writes #%app as written.
(print-extended-identifiers #t)

(define (print-expanded f) (pretty-print (stx->datum f)))

;; A datum as subc read writes it, for comparing readers: each syntax
;; object as [line:col:pos:span datum], symbols as Sname, keywords as
;; Kname, characters as C<code>, strings as their code points, flonums as
;; F<signed bits>.
(define (dump x)
  (cond [(stx? x)
         (let ([l (stx-srcloc x)])
           (printf "[~a:~a:~a:~a " (srcloc-line l) (srcloc-col l) (srcloc-pos l) (srcloc-span l))
           (dump (stx-e x))
           (display "]"))]
        [(pair? x)
         (display "(")
         (dump (car x))
         (let loop ([t (cdr x)])
           (cond [(pair? t) (display " ") (dump (car t)) (loop (cdr t))]
                 [(null? t) (void)]
                 [else (display " . ") (dump t)]))
         (display ")")]
        [(null? x) (display "()")]
        [(symbol? x) (display "S") (display (symbol->string x))]
        [(keyword? x) (display "K") (display (keyword-name x))]
        [(string? x)
         (display "\"")
         (let loop ([cs (string->list x)] [first #t])
           (unless (null? cs)
             (unless first (display ","))
             (display (char->integer (car cs)))
             (loop (cdr cs) #f)))
         (display "\"")]
        [(char? x) (printf "C~a" (char->integer x))]
        [(and (integer? x) (exact? x)) (display x)]
        [(flonum? x)
         (let ([bv (make-bytevector 8)])
           (bytevector-ieee-double-set! bv 0 x (endianness little))
           (printf "F~a" (bytevector-s64-ref bv 0 (endianness little))))]
        [(boolean? x) (display (if x "#t" "#f"))]
        [else (display "?")]))

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
      [(and (>= (length args) 2) (string=? (car args) "run"))
       (run-module (compile-module-file (cadr args)) (cddr args))]
      [(and (>= (length args) 2) (string=? (car args) "build"))
       (let* ([linklets (program-linklets (compile-module-file (cadr args)))]
              [dir (option args "-o" (strip-extension (cadr args)))])
         (unless (file-directory? dir) (mkdir dir))
         (for-each (lambda (l) (write-file (format "~a/~a.wasm" dir (car l)) (cdr l))) linklets)
         (write-file (format "~a/program" dir)
                     (string->utf8 (apply string-append (map (lambda (l) (string-append (car l) "\n")) linklets)))))]
      [(and (>= (length args) 2) (string=? (car args) "compile"))
       (let* ([m (compile-module-file (cadr args))]
              [out (option args "-o" (string-append (strip-extension (cadr args)) ".wasm"))])
         (for-each (lambda (p)
                     (write-file (if (= (car p) 0)
                                     out
                                     (format "~a.phase~a.wasm" (strip-extension out) (car p)))
                                 (cdr p)))
                   (module-linklet-list m)))]
      [(and (= (length args) 2) (string=? (car args) "read"))
       (for-each (lambda (d) (dump d) (newline)) (read-file (cadr args)))]
      [(and (= (length args) 2) (string=? (car args) "expand"))
       (for-each print-expanded (module-expanded-forms (compile-module-file (cadr args))))]
      [(and (>= (length args) 1) (string=? (car args) "syntax-library"))
       (write-file (option args "-o" "build/syntax.wasm") (syntax-library-bytes))]
      [else (die 64 "usage: subc run FILE [ARG ...] | build FILE [-o DIR] | compile FILE [-o OUT] | expand FILE | syntax-library [-o OUT]")])
    (flush-output-port (current-output-port))))

(main (command-line-arguments))
