;; Lifecycle: stage0. Part of the bootstrap compiler, frozen once the
;; compiler compiles itself.
;;
;; Entry script for bin/subc: silence library compile notices (they would
;; land in program output), then run the driver.
(compile-file-message #f)
(load-program (string-append (or (getenv "SUBSTRATE_ROOT") ".") "/stage0/main.ss"))
