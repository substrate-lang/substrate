// Lifecycle: experimental.
//
// Browser tests for the web pages in next/web. next/tests/web/run.sh
// builds one site per page and then runs this script:
//
//   node next/tests/web/pages.mjs SITES NAME ...
//
// SITES is the directory that holds the sites, one subdirectory per page.
// Each NAME is a subdirectory to test, and also the name of its test
// function in `checks` below.
//
// The script serves SITES on a local port, opens each page in headless
// Chromium (host/web/browser.mjs), clicks and types as a user would, and
// compares what the page shows with what is expected. It prints "ok NAME"
// or the failed checks, and exits with status 1 if anything failed.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser } from '../../../host/web/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [sites, ...names] = process.argv.slice(2);

let failed = 0;
// Records a failure unless `got` equals `expected`. `what` describes the
// check and is printed if it fails.
function check(what, got, expected) {
  if (got === expected) return;
  failed++;
  console.log(`FAIL ${what}\n--- got\n${got}\n--- expected\n${expected}`);
}

// JavaScript, evaluated in the page, that returns the HTML the program
// has drawn.
const root = 'document.getElementById("root").innerHTML';

const checks = {
  // next/web/examples/counter.sub: a number with -, + and reset buttons.
  // (The <!--a--> comment in the HTML is a placeholder that ui.sub leaves
  // where the optional reset button goes.)
  async counter(page) {
    check('counter: initial page', await page.evaluate(root),
      '<div class="counter"><button>-</button><span class="count">0</span><button>+</button><!--a--></div>');
    await page.click('button:nth-of-type(2)');
    await page.click('button:nth-of-type(2)');
    check('counter: after clicking + twice', await page.evaluate(root),
      '<div class="counter"><button>-</button><span class="count">2</span><button>+</button><button>reset</button><!--a--></div>');
    for (let i = 0; i < 3; i++) await page.click('button:nth-of-type(1)');
    check('counter: after clicking - three times', await page.evaluate(root),
      '<div class="counter"><button>-</button><span class="negative">-1</span><button>+</button><button>reset</button><!--a--></div>');
    await page.click('button:nth-of-type(3)');
    check('counter: after clicking reset', await page.evaluate(root),
      '<div class="counter"><button>-</button><span class="count">0</span><button>+</button><!--a--></div>');
  },

  // next/web/repl: the REPL page.
  //
  // `entries()` returns the page's entries as strings of the form
  // "input => output". An entry that failed starts with "! ", and one that
  // is still running starts with "~ ". Backtrace lines (which start with
  // four spaces) are removed, because their content depends on the host.
  //
  // Inputs are evaluated in a worker, so results arrive a little later.
  // `idle()` waits until the page shows that nothing is running.
  async repl(page) {
    const entries = () => page.evaluate(`[...document.querySelectorAll('section.entry')].map((s) => {
      const output = s.querySelector('.output');
      const lines = output ? output.textContent.split('\\n').filter((l) => !l.startsWith('    ')).join('\\n') : '';
      const mark = s.classList.contains('failed') ? '! ' : s.classList.contains('running') ? '~ ' : '';
      return mark + s.querySelector('.input').textContent + ' => ' + lines;
    })`);
    const shown = async () => (await entries()).join('\n');
    const last = async () => (await entries()).pop();
    const idle = () => page.waitFor('!document.querySelector("section.running, p.status, button.stop")', 60000);
    // Types an input, presses Enter, and waits for the result.
    const say = async (text) => {
      await page.type(text);
      await page.press('Enter');
      await idle();
    };
    const fieldText = () => page.evaluate('document.querySelector("textarea").value');

    const substrate = '(require-unqualified substrate "next/substrate/substrate.sub") => ';
    await idle();
    check('repl: the page starts a Substrate session', await shown(), substrate);
    check('repl: the text box has the focus', await page.evaluate('document.activeElement.tagName'), 'TEXTAREA');

    await say('(define (sq x) (* x x))');
    await say('(sq 7)');
    await say('(car 5)');
    // Enter inside an unfinished list inserts a line break instead of
    // evaluating.
    await page.type('(map sq');
    await page.press('Enter');
    await say("     '(1 2 3))");
    await say('(nope)');
    // Defining a name again replaces the earlier definition.
    await say('(define (sq x) (* x x x))');
    await say('(sq 3)');
    check('repl: definitions, values and errors in Substrate', await shown(), [
      substrate,
      '(define (sq x) (* x x)) => ',
      '(sq 7) => 49',
      '! (car 5) => error: car: expected a pair, got 5',
      "(map sq\n     '(1 2 3)) => (1 4 9)",
      '! (nope) => input-6:1:2: error: unbound identifier nope',
      '(define (sq x) (* x x x)) => ',
      '(sq 3) => 27',
    ].join('\n'));
    check('repl: the text box is empty after an input', await fieldText(), '');

    // The up and down arrow keys recall earlier inputs.
    await page.press('ArrowUp');
    check('repl: ArrowUp recalls the previous input', await fieldText(), '(sq 3)');
    await page.press('ArrowUp');
    await page.press('ArrowDown');
    await page.press('Enter');
    await idle();
    check('repl: a recalled input can be evaluated again', await last(), '(sq 3) => 27');

    // A macro that traps crashes the compiler in the middle of an input.
    // The session recovers (session.sub, on-trap), reports the trap as
    // the input's error, and keeps working.
    await say('(begin-for-syntax (func (trapping [s i32]) -> i32 (unreachable)))');
    await say('(define-syntax trap! trapping)');
    await say('(trap! 1)');
    check('repl: a trap in a macro is reported as the input\'s error', (await last()).split(' at ')[0],
      '! (trap! 1) => input-12:1:1: error: trap: unreachable');
    await say('(sq 2)');
    check('repl: the session still works after the trap', await last(), '(sq 2) => 8');

    // An input that loops forever. The page must stay usable, and the
    // Stop button must end it. Afterwards the session is restored, so
    // earlier definitions (sq) still exist.
    await page.type('(let loop () (loop))');
    await page.press('Enter');
    await page.waitFor('document.querySelector("button.stop")');
    check('repl: a looping input shows as running', await last(), '~ (let loop () (loop)) => ');
    await page.type('(sq 5)');
    check('repl: the user can type while an input is running', await fieldText(), '(sq 5)');
    await page.press('Enter');
    check('repl: Enter does not evaluate while an input is running', await last(), '~ (let loop () (loop)) => ');
    check('repl: Clear is disabled while an input is running',
      await page.evaluate('document.querySelector("nav button.quiet").disabled'), true);
    await page.click('button.stop');
    await idle();
    check('repl: Stop ends the looping input', await last(), '! (let loop () (loop)) => Stopped.');
    await page.press('Enter');
    await idle();
    check('repl: earlier definitions survive Stop', await last(), '(sq 5) => 125');

    // An input that prints forever. Its output appears while it runs, and
    // the page keeps only a limited amount of it.
    await page.type('(let loop ([n 0]) (display n) (newline) (loop (+ n 1)))');
    await page.press('Enter');
    await page.waitFor('document.querySelector("section.running .output")?.textContent.includes("more output not shown")', 60000);
    check('repl: output appears while the input is still running',
      (await last()).split('\n').slice(0, 3).join(' '), '~ (let loop ([n 0]) (display n) (newline) (loop (+ n 1))) => 0 1 2');
    check('repl: endless output is cut off with a notice', (await last()).split('\n').pop(), '... (more output not shown)');
    await page.click('button.stop');
    await idle();
    check('repl: Stop ends the printing input', (await last()).split('\n').pop(), 'Stopped.');

    // The second language button starts a new session in the C-like Lisp.
    // Names from the old session (sq) are gone.
    await page.click('nav button:nth-of-type(2)');
    await idle();
    await say('(define (fib [n i32]) -> i32 (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))');
    await say('(+ (fib 20) 0.5)');
    await say('(sq 2)');
    check('repl: a session in the C-like Lisp', await shown(), [
      '(require-unqualified c "next/c/c.sub") => ',
      '(define (fib [n i32]) -> i32 (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) => ',
      '(+ (fib 20) 0.5) => 6765.5',
      '! (sq 2) => input-20:1:2: error: unbound identifier sq',
    ].join('\n'));
    check('repl: the text box has the focus after a language button',
      await page.evaluate('document.activeElement.tagName'), 'TEXTAREA');

    // C-like Lisp code can write to any address. This input overwrites
    // 4 MB of the session's memory, including the compiler's own data, so
    // the session can no longer reply. The page is a separate program
    // with separate memory: it notices, starts a new session, and
    // restores the earlier definitions (fib).
    await page.type('(memset (cast (ptr void) 8) 255 4000000)');
    await page.press('Enter');
    await idle();
    check('repl: an input that corrupts the session fails', (await last()).split('\n')[0],
      '! (memset (cast (ptr void) 8) 255 4000000) => 8');
    check('repl: the page reports that the session crashed', (await last()).split('\n').pop(),
      'The session crashed while evaluating this input. A new session was started.');
    await say('(fib 10)');
    check('repl: earlier definitions survive the crash', await last(), '(fib 10) => 55');

    // Clear removes the entries from the page but keeps the session.
    await page.click('nav button.quiet');
    check('repl: Clear empties the page', await shown(), '');
    await say('(fib 11)');
    check('repl: Clear keeps the session', await shown(), '(fib 11) => 89');

    // The fourth button starts a session with no language: kernel code.
    await page.click('nav button:nth-of-type(4)');
    check('repl: a kernel session starts empty', await shown(), '');
    await say('(require print "lib/print.sub")');
    await say('(print:write-int (i32.add 40 2))');
    check('repl: a session in kernel code', await shown(), [
      '(require print "lib/print.sub") => ',
      '(print:write-int (i32.add 40 2)) => 42',
    ].join('\n'));
  },

  // next/web/examples/rows.sub: a table whose rows are created, swapped,
  // removed and updated. `ids()` returns the row ids in page order.
  async rows(page) {
    const ids = () => page.evaluate('[...document.querySelectorAll("tbody tr td.id")].map((td) => Number(td.textContent))');
    const upTo = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);
    const same = (what, got, expected) => check(what, JSON.stringify(got), JSON.stringify(expected));
    await page.click('#create');
    same('rows: create 1,000 rows', await ids(), upTo(1000));
    await page.click('#swap');
    const swapped = upTo(1000);
    [swapped[1], swapped[998]] = [swapped[998], swapped[1]];
    same('rows: swap two rows', await ids(), swapped);
    await page.evaluate('document.querySelector("tbody tr:nth-child(500) a.remove").click()');
    swapped.splice(499, 1);
    same('rows: remove one row', await ids(), swapped);
    await page.evaluate('document.querySelector("tbody tr:nth-child(3) td:nth-child(2) a").click()');
    same('rows: select one row', await page.evaluate('[...document.querySelectorAll("tbody tr.selected td.id")].map((td) => Number(td.textContent))'), [3]);
    await page.click('#update');
    check('rows: update every tenth row', await page.evaluate(
      '[...document.querySelectorAll("tbody tr")].filter((tr) => tr.children[1].textContent.endsWith(" !!!")).length'), 100);
    await page.click('#append');
    same('rows: append 1,000 rows', await ids(), [...swapped, ...upTo(1000, 1001)]);

    // A regression test for a use-after-free. Each row's click listener
    // refers to data in the program's memory that is freed when the row
    // is removed. If a script keeps a reference to a removed row's link
    // and clicks it later, the click must not reach the program.
    // `window.given` counts calls into the program.
    await page.evaluate(`(() => {
      window.kept = document.querySelector("tbody tr:nth-child(7) td:nth-child(2) a");
      window.given = 0;
      const call = window.app.call;
      window.app.call = (...args) => { window.given++; return call(...args); };
    })()`);
    await page.click('#clear');
    same('rows: clear removes every row', await ids(), []);
    check('rows: clear leaves only the placeholder node', await page.evaluate('document.querySelector("tbody").childNodes.length'), 1);
    await page.evaluate('(() => { window.given = 0; window.kept.click(); })()');
    check('rows: a click on a removed row does not reach the program', await page.evaluate('window.given'), 0);
    await page.click('#create');
    check('rows: a click on a current row reaches the program once', await page.evaluate(
      '(() => { window.given = 0; document.querySelector("tbody tr:nth-child(7) td:nth-child(2) a").click(); return window.given; })()'), 1);
  },

  // next/tests/web/fields.sub: form fields. It tests the typed attributes
  // (boolean ones like `disabled`, numeric ones like `colspan`) and the
  // event data that a listener can put in its message: (event value),
  // (event key), (event shift), (event checked).
  //
  // The page shows "TYPED|KEY|SENT|CUSTOM": the text typed so far, the
  // last key pressed, and how many times the Send button and a custom
  // event were handled.
  async fields(page) {
    const shown = () => page.evaluate('document.getElementById("shown").textContent');
    const attribute = (id, name) => page.evaluate(`document.getElementById("${id}").getAttribute("${name}")`);
    check('fields: initial page', await shown(), '||0|0');
    check('fields: constant attributes are part of the HTML', await page.evaluate('document.getElementById("field").outerHTML'),
      '<input id="field" type="text" maxlength="12" autofocus="">');
    check('fields: the Send button starts disabled', await attribute('send', 'disabled'), '');
    check('fields: colspan starts at 1', await attribute('cell', 'colspan'), '1');
    check('fields: a textarea gets its initial value',
      await page.evaluate('document.getElementById("area").value'), 'kept');
    await page.click('#send');
    check('fields: clicking a disabled button does nothing', await shown(), '||0|0');

    await page.click('#field');
    await page.type('abc');
    check('fields: (event value) is the text typed', await shown(), 'abc||0|0');
    check('fields: a numeric attribute follows the model', await attribute('cell', 'colspan'), '4');
    // The second argument of press is the modifier keys: 8 is Shift, 2 is
    // Control.
    await page.press('Enter', 8);
    check('fields: (event key) and (event shift)', await shown(), 'abc|Enter+shift|0|0');
    await page.press('ArrowUp', 2);
    check('fields: (event control)', await shown(), 'abc|ArrowUp+control|0|0');
    await page.press('ArrowDown');
    check('fields: a key with no modifier', await shown(), 'abc|ArrowDown|0|0');

    await page.click('#box');
    check('fields: ticking the checkbox enables the Send button', await attribute('send', 'disabled'), null);
    check('fields: the checkbox is ticked', await page.evaluate('document.getElementById("box").checked'), true);
    await page.click('#send');
    check('fields: the enabled button can be clicked', await shown(), 'abc|ArrowDown|1|0');
    await page.click('#box');
    check('fields: unticking the checkbox disables the button again', await attribute('send', 'disabled'), '');
    check('fields: the checkbox is not ticked', await page.evaluate('document.getElementById("box").checked'), false);

    await page.evaluate('document.getElementById("part").dispatchEvent(new Event("my-event"))');
    check('fields: a custom event, named by a string in the template', await shown(), 'abc|ArrowDown|1|1');
  },

  // next/tests/web/guests.sub: guests (sandboxed programs; see
  // host/web/guest.mjs). The page keeps a log of every guest event and of
  // its own actions. The test waits for the scripted part to finish,
  // clicks the page's buttons, and compares the whole log. guests.sub and
  // a-guest.sub explain each step.
  async guests(page) {
    // Backtrace lines start with four spaces. They are removed because
    // their content depends on the host.
    const log = async () => (await page.evaluate('document.getElementById("log").textContent'))
      .split('\n').filter((l) => !l.startsWith('    ')).join('\n');
    await page.waitFor('document.getElementById("log").textContent.includes("guest 3 is now looping")', 30000);
    await page.click('#tick');
    await page.click('#tick');
    check('guests: the page responds while a guest loops forever', await page.evaluate('document.getElementById("ticks").textContent'), '2');
    await page.click('#stop');
    await page.waitFor('document.getElementById("log").textContent.endsWith("finished\\n")');
    check('guests: the log of events', await log(), [
      // Guest 1 starts and prints its arguments.
      '1 stdout: a guest, one, two words',
      '1 done',
      // It keeps its total between messages.
      '1 message: total 5',
      '1 done',
      '1 message: total 42',
      '1 done',
      // Standard output and standard error arrive as events.
      '1 stdout: hello',
      '1 message: said',
      '1 done',
      '1 stderr: careful',
      '1 message: warned',
      '1 done',
      // It can read only the directory it was granted, and write only
      // where it was allowed to.
      '1 message: read 12 bytes',
      '1 done',
      '1 message: cannot read /secret/key.txt: No such file or directory',
      '1 done',
      '1 message: wrote',
      '1 done',
      '1 message: read 7 bytes',
      '1 done',
      '1 message: cannot write /data/note.txt: Permission denied',
      '1 done',
      // A trap is reported, and the guest keeps running with its state.
      '1 message: trapped: trap: divide by zero',
      '1 done: trap: divide by zero',
      '1 message: total 43',
      '1 done',
      // A guest cannot start guests.
      '1 message: no guest: guest.start: a guest cannot start guests of its own',
      '1 done',
      // The 32 MiB memory limit stops allocation; the guest keeps running.
      '1 message: out of memory before 32 MiB',
      '1 done',
      '1 message: total 44',
      '1 done',
      // The guest exits; after that it cannot be sent messages.
      '1 ended: exit 3',
      'send to guest 1 returned -1',
      // Guest 2 loops forever and is ended by its 300 ms time limit.
      '2 stdout: a guest',
      '2 done',
      '2 ended: time limit exceeded (300 ms)',
      // Guest 3 loops forever and is ended by the Stop button.
      '3 stdout: a guest',
      '3 done',
      '3 message: total 2',
      'guest 3 is now looping',
      '3 done',
      'stopped guest 3; send to it returned -1',
      // Specs that are wrong.
      'no guest: guest.start: no program found in /nowhere',
      'no guest: guest.start: unknown setting "frobnicate" in the spec',
      'no guest: guest.start: "time" needs a positive whole number, not "soon"',
      'finished',
      '',
    ].join('\n'));
    check('guests: a file written by a guest does not appear in the page\'s files',
      await page.evaluate('window.app.files.has("/out/made.txt")'), false);
  },

  // next/tests/web/focus.sub: a regression test for events that fire
  // while the page is being updated.
  //
  // Clicking "turn" makes the program move the keyboard focus to a text
  // field. Moving the focus fires a focus event immediately, in the
  // middle of the update, and the program listens for it. The update must
  // still be applied exactly once: the page shows one "mark" element, not
  // two. The page shows "TURNS FOCUSED BLURRED" as three counters.
  async focus(page) {
    const counts = () => page.evaluate('document.getElementById("counts").textContent');
    const marks = () => page.evaluate('document.querySelectorAll("span.mark").length');
    check('focus: initial page', await counts(), '0 0 0');
    await page.click('#turn');
    check('focus: the program receives the focus event', await counts(), '1 1 0');
    check('focus: the field has the focus', await page.evaluate('document.activeElement.id'), 'field');
    check('focus: the update was applied once', await marks(), 1);
    // Clicking the button first takes the focus away from the field (a
    // blur event), then the program gives it back.
    await page.click('#turn');
    check('focus: second click', await counts(), '2 2 1');
    check('focus: still one mark', await marks(), 1);
  },
};

// Serve the sites (port 0 = any free port; serve.mjs prints its address),
// then run each named check in a fresh page.
const server = spawn(path.join(here, '../../../host/web/serve.mjs'), [sites, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
try {
  await withBrowser(async (open) => {
    for (const name of names) {
      const before = failed;
      const page = await open(`${url}${name}/index.html`);
      try {
        // Each page sets window.ready when its program has started.
        await page.waitFor('window.ready', 60000);
        await checks[name](page);
      } catch (e) {
        failed++;
        console.log(`FAIL ${name}: ${e.message}`);
      }
      if (failed === before) console.log(`ok   ${name}`);
      else console.log(`--- browser console of ${name}\n${page.log.join('\n')}`);
    }
  }, { dir: sites });
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
