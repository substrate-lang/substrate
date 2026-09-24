;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Reader: text -> syntax objects with source locations and empty scopes.
(library (stage0 reader)
  (export read-file read-string-all)
  (import (chezscheme) (stage0 syntax))

  (define (read-file path)
    (read-string-all (call-with-input-file path get-string-all) (string->symbol path)))

  ;; Read every datum in text; source names the file in srclocs.
  (define (read-string-all text source)
    (define len (string-length text))
    (define pos 0)
    (define line 1)
    (define col 0)

    (define (peek) (if (< pos len) (string-ref text pos) #f))
    (define (peek2) (if (< (+ pos 1) len) (string-ref text (+ pos 1)) #f))
    (define (next!)
      (let ([c (string-ref text pos)])
        (set! pos (+ pos 1))
        (if (char=? c #\newline)
            (begin (set! line (+ line 1)) (set! col 0))
            (set! col (+ col 1)))
        c))

    (define (here) (list pos line col))
    (define (loc-from start)
      (make-srcloc source (cadr start) (caddr start) (car start) (- pos (car start))))
    (define (fail start fmt . args)
      (apply raise-compile-error (make-srcloc source (cadr start) (caddr start) (car start) 1)
             (string-append "read: " fmt) args))

    (define (delimiter? c)
      (or (not c) (char-whitespace? c) (memv c '(#\( #\) #\[ #\] #\" #\;))))

    ;; Skip whitespace and comments. Returns when the next char starts a datum.
    (define (skip-atmosphere!)
      (let ([c (peek)])
        (cond [(not c) (void)]
              [(char-whitespace? c) (next!) (skip-atmosphere!)]
              [(char=? c #\;)
               (let loop () (let ([c (peek)]) (when (and c (not (char=? c #\newline))) (next!) (loop))))
               (skip-atmosphere!)]
              [(and (char=? c #\#) (eqv? (peek2) #\|))
               (let ([start (here)])
                 (next!) (next!)
                 (let loop ([depth 1])
                   (cond [(= depth 0) (void)]
                         [(not (peek)) (fail start "unterminated block comment")]
                         [(and (char=? (peek) #\|) (eqv? (peek2) #\#)) (next!) (next!) (loop (- depth 1))]
                         [(and (char=? (peek) #\#) (eqv? (peek2) #\|)) (next!) (next!) (loop (+ depth 1))]
                         [else (next!) (loop depth)])))
               (skip-atmosphere!)]
              [(and (char=? c #\#) (eqv? (peek2) #\;))
               (next!) (next!)
               (read-datum)
               (skip-atmosphere!)]
              [else (void)])))

    (define (read-token)
      (let loop ([acc '()])
        (if (delimiter? (peek))
            (list->string (reverse acc))
            (loop (cons (next!) acc)))))

    (define (wrap start e) (make-stx e '() (loc-from start) '()))

    ;; (prefix-form start 'quote) reads the next datum and wraps it.
    (define (prefix-form start sym)
      (let* ([head-loc (loc-from start)]
             [d (read-datum)])
        (unless d (fail start "expected a datum after ~a" sym))
        (wrap start (list (make-stx sym '() head-loc '()) d))))

    (define (read-list start close)
      (let loop ([acc '()])
        (skip-atmosphere!)
        (let ([c (peek)])
          (cond [(not c) (fail start "unterminated list")]
                [(memv c '(#\) #\]))
                 (unless (char=? c close) (fail (here) "mismatched ~a" c))
                 (next!)
                 (wrap start (reverse acc))]
                [(and (char=? c #\.) (delimiter? (peek2)) (pair? acc))
                 (next!)
                 (let ([tail (read-datum)])
                   (skip-atmosphere!)
                   (unless (eqv? (peek) close) (fail start "expected ~a after dotted tail" close))
                   (next!)
                   (wrap start (append (reverse acc) tail)))]
                [else (loop (cons (read-datum) acc))]))))

    (define (read-string-lit start)
      (next!)
      (let loop ([acc '()])
        (let ([c (peek)])
          (cond [(not c) (fail start "unterminated string")]
                [(char=? c #\") (next!) (wrap start (list->string (reverse acc)))]
                [(char=? c #\\)
                 (next!)
                 (let ([e (and (peek) (next!))])
                   (case e
                     [(#\n) (loop (cons #\newline acc))]
                     [(#\t) (loop (cons #\tab acc))]
                     [(#\r) (loop (cons #\return acc))]
                     [(#\0) (loop (cons #\nul acc))]
                     [(#\\ #\") (loop (cons e acc))]
                     [(#\x)
                      (let hex ([digits '()])
                        (let ([h (peek)])
                          (cond [(not h) (fail start "unterminated \\x escape")]
                                [(char=? h #\;)
                                 (next!)
                                 (let ([n (string->number (list->string (reverse digits)) 16)])
                                   (unless n (fail start "bad \\x escape"))
                                   (loop (cons (integer->char n) acc)))]
                                [else (next!) (hex (cons h digits))])))]
                     [else (fail start "unknown string escape \\~a" e)]))]
                [else (next!) (loop (cons c acc))]))))

    (define char-names
      '(("space" . #\space) ("newline" . #\newline) ("tab" . #\tab) ("nul" . #\nul)
        ("return" . #\return) ("linefeed" . #\newline) ("delete" . #\delete) ("alarm" . #\alarm)
        ("backspace" . #\backspace) ("escape" . #\esc)))

    (define (read-char-lit start)
      ;; after #\ : one char, then any following non-delimiters
      (let* ([first (next!)]
             [rest (read-token)]
             [tok (string-append (string first) rest)])
        (cond [(= (string-length tok) 1) (wrap start first)]
              [(assoc tok char-names) => (lambda (p) (wrap start (cdr p)))]
              [(and (char=? first #\x) (string->number rest 16))
               => (lambda (n) (wrap start (integer->char n)))]
              [else (fail start "unknown character #\\~a" tok)])))

    (define (read-hash start)
      (next!)
      (let ([c (peek)])
        (cond [(not c) (fail start "unexpected end after #")]
              [(char=? c #\() (fail start "vector syntax #( is not part of the kernel")]
              [(char=? c #\') (next!) (prefix-form start 'quote-syntax)]
              [(char=? c #\`) (next!) (prefix-form start 'quasisyntax)]
              [(char=? c #\,)
               (next!)
               (if (eqv? (peek) #\@)
                   (begin (next!) (prefix-form start 'unsyntax-splicing))
                   (prefix-form start 'unsyntax))]
              [(char=? c #\\) (next!) (read-char-lit start)]
              ;; #:name is a keyword, as in Racket.
              [(char=? c #\:) (next!) (wrap start (string->keyword (read-token)))]
              ;; #%name is a symbol, used for implicit forms like #%app.
              [(char=? c #\%) (wrap start (string->symbol (string-append "#" (read-token))))]
              [else
               (let ([tok (read-token)])
                 (cond [(member tok '("t" "true")) (wrap start #t)]
                       [(member tok '("f" "false")) (wrap start #f)]
                       [(string->number (string-append "#" tok)) => (lambda (n) (wrap start (check-number start n)))]
                       [else (fail start "unknown syntax #~a" tok)]))])))

    (define (read-datum)
      (skip-atmosphere!)
      (let ([start (here)] [c (peek)])
        (cond [(not c) #f]
              [(memv c '(#\( #\[)) (next!) (read-list start (if (char=? c #\() #\) #\]))]
              [(memv c '(#\) #\])) (fail start "unexpected ~a" c)]
              [(char=? c #\') (next!) (prefix-form start 'quote)]
              [(char=? c #\`) (next!) (prefix-form start 'quasiquote)]
              [(char=? c #\,)
               (next!)
               (if (eqv? (peek) #\@)
                   (begin (next!) (prefix-form start 'unquote-splicing))
                   (prefix-form start 'unquote))]
              [(char=? c #\") (read-string-lit start)]
              [(char=? c #\#) (read-hash start)]
              [else
               (let* ([tok (read-token)]
                      [n (and (not (string=? tok ".")) (string->number tok))])
                 (wrap start (if n (check-number start n) (string->symbol tok))))])))

    ;; The kernel's number literals are integers of up to 64 bits, from
    ;; -2^63 to 2^64 - 1 as in wasm, and floats (spec 5.4).
    (define (check-number start n)
      (cond [(and (integer? n) (exact? n))
             (unless (<= (- (expt 2 63)) n (- (expt 2 64) 1))
               (fail start "the integer ~a does not fit in 64 bits" n))
             n]
            [(flonum? n) n]
            [else (fail start "~a is not a number literal: use integers and decimals" n)]))

    (let loop ([acc '()])
      (let ([d (read-datum)])
        (if d (loop (cons d acc)) (reverse acc))))))
