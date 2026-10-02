// Lifecycle: experimental. next/tests/web/run.sh's checks of pages whose
// programs' views are ui.sub's (next/web), each a site next/web/site.sh
// made, in Chromium: the page's nodes, as its HTML, after it loads and
// after each event a check gives it.
//
//   node next/tests/web/pages.mjs SITES NAME ...
//
// SITES is the directory the sites are in, each under its name.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser } from '../../../host/web/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [sites, ...names] = process.argv.slice(2);

let failed = 0;
// what must be so: got is expected.
function check(what, got, expected) {
  if (got === expected) return;
  failed++;
  console.log(`FAIL ${what}\n--- got\n${got}\n--- expected\n${expected}`);
}

const root = 'document.getElementById("root").innerHTML';

const checks = {
  // next/web/examples/counter.sub
  async counter(page) {
    check('the counter, loaded', await page.evaluate(root),
      '<div class="counter"><button>-</button><span class="count">0</span><button>+</button><!--a--></div>');
    await page.click('button:nth-of-type(2)');
    await page.click('button:nth-of-type(2)');
    check('after + twice', await page.evaluate(root),
      '<div class="counter"><button>-</button><span class="count">2</span><button>+</button><button>reset</button><!--a--></div>');
    for (let i = 0; i < 3; i++) await page.click('button:nth-of-type(1)');
    check('after - three times', await page.evaluate(root),
      '<div class="counter"><button>-</button><span class="negative">-1</span><button>+</button><button>reset</button><!--a--></div>');
    await page.click('button:nth-of-type(3)');
    check('after reset', await page.evaluate(root),
      '<div class="counter"><button>-</button><span class="count">0</span><button>+</button><!--a--></div>');
  },

  // next/web/repl/repl.sub: what its entries show, each "input => output",
  // an entry that failed marked !, with a backtrace's frames left out.
  async repl(page) {
    const shown = async () => (await page.evaluate(`[...document.querySelectorAll('section.entry')].map((s) => {
      const output = s.querySelector('.output');
      const lines = output ? output.textContent.split('\\n').filter((l) => !l.startsWith('    ')).join('\\n') : '';
      return (s.classList.contains('failed') ? '! ' : '') + s.querySelector('.input').textContent + ' => ' + lines;
    }).join('\\n')`));
    const say = async (text) => {
      await page.type(text);
      await page.press('Enter');
    };
    const substrate = '(require-unqualified substrate "next/substrate/substrate.sub") => ';
    check('the session, loaded: its first input requires Substrate', await shown(), substrate);
    check('the field has the focus', await page.evaluate('document.activeElement.tagName'), 'TEXTAREA');

    await say('(define (sq x) (* x x))');
    await say('(sq 7)');
    await say('(car 5)');
    // Enter in a list that is open is a new line.
    await page.type('(map sq');
    await page.press('Enter');
    await say("     '(1 2 3))");
    await say('(nope)');
    // A definition again shadows the one before.
    await say('(define (sq x) (* x x x))');
    await say('(sq 3)');
    const first = [
      substrate,
      '(define (sq x) (* x x)) => ',
      '(sq 7) => 49',
      '! (car 5) => error: car: expected a pair, got 5',
      "(map sq\n     '(1 2 3)) => (1 4 9)",
      '! (nope) => input-6:1:2: error: unbound identifier nope',
      '(define (sq x) (* x x x)) => ',
      '(sq 3) => 27',
    ].join('\n');
    check('inputs in Substrate', await shown(), first);
    check('the field is empty after an input', await page.evaluate('document.querySelector("textarea").value'), '');

    // The arrows recall the inputs.
    await page.press('ArrowUp');
    check('the input before', await page.evaluate('document.querySelector("textarea").value'), '(sq 3)');
    await page.press('ArrowUp');
    await page.press('ArrowDown');
    await page.press('Enter');
    check('recalled, and evaluated again', (await shown()).split('\n').pop(), '(sq 3) => 27');

    // A macro that traps unwinds the compiler: the program's on-trap puts
    // the session right, and it goes on.
    await say('(begin-for-syntax (func (trapping [s i32]) -> i32 (unreachable)))');
    await say('(define-syntax trap! trapping)');
    await say('(trap! 1)');
    check('a trap in a macro is the input\'s error', (await shown()).split('\n').pop().split(' at ')[0],
      '! (trap! 1) => input-12:1:1: error: trap: unreachable');
    await say('(sq 2)');
    check('and the session goes on', (await shown()).split('\n').pop(), '(sq 2) => 8');

    // Another language: a new session, whose first input requires it.
    await page.click('nav button:nth-of-type(2)');
    await say('(define (fib [n i32]) -> i32 (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))');
    await say('(+ (fib 20) 0.5)');
    await say('(sq 2)');
    check('a session in the C-like Lisp', await shown(), [
      '(require-unqualified c "next/c/c.sub") => ',
      '(define (fib [n i32]) -> i32 (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) => ',
      '(+ (fib 20) 0.5) => 6765.5',
      '! (sq 2) => input-17:1:2: error: unbound identifier sq',
    ].join('\n'));
    check('the field has the focus after a button', await page.evaluate('document.activeElement.tagName'), 'TEXTAREA');

    await page.click('nav button.quiet');
    check('cleared', await shown(), '');
    await say('(fib 10)');
    check('the session is as it was', await shown(), '(fib 10) => 55');

    // A session that requires nothing is in kernel code.
    await page.click('nav button:nth-of-type(4)');
    check('a new session, with no input', await shown(), '');
    await say('(require print "lib/print.sub")');
    await say('(print:write-int (i32.add 40 2))');
    check('a session in kernel code', await shown(), [
      '(require print "lib/print.sub") => ',
      '(print:write-int (i32.add 40 2)) => 42',
    ].join('\n'));
  },

  // next/web/examples/rows.sub: an each's rows in the page, by their ids,
  // as its rows are made, moved and taken away.
  async rows(page) {
    const ids = () => page.evaluate('[...document.querySelectorAll("tbody tr td.id")].map((td) => Number(td.textContent))');
    const upTo = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);
    const same = (what, got, expected) => check(what, JSON.stringify(got), JSON.stringify(expected));
    await page.click('#create');
    same('1,000 rows', await ids(), upTo(1000));
    await page.click('#swap');
    const swapped = upTo(1000);
    [swapped[1], swapped[998]] = [swapped[998], swapped[1]];
    same('two swapped', await ids(), swapped);
    await page.evaluate('document.querySelector("tbody tr:nth-child(500) a.remove").click()');
    swapped.splice(499, 1);
    same('one removed', await ids(), swapped);
    await page.evaluate('document.querySelector("tbody tr:nth-child(3) td:nth-child(2) a").click()');
    same('one selected', await page.evaluate('[...document.querySelectorAll("tbody tr.selected td.id")].map((td) => Number(td.textContent))'), [3]);
    await page.click('#update');
    check('every tenth changed', await page.evaluate(
      '[...document.querySelectorAll("tbody tr")].filter((tr) => tr.children[1].textContent.endsWith(" !!!")).length'), 100);
    await page.click('#append');
    same('1,000 more', await ids(), [...swapped, ...upTo(1000, 1001)]);
    // A row's listener holds a message in the row's memory, which goes
    // with the row: an event that reaches a row the page no longer has,
    // as a click a script gives one it kept, is not the program's.
    await page.evaluate(`(() => {
      window.kept = document.querySelector("tbody tr:nth-child(7) td:nth-child(2) a");
      window.given = 0;
      const call = window.app.call;
      window.app.call = (...args) => { window.given++; return call(...args); };
    })()`);
    await page.click('#clear');
    same('none', await ids(), []);
    check('nothing left of them', await page.evaluate('document.querySelector("tbody").childNodes.length'), 1);
    await page.evaluate('(() => { window.given = 0; window.kept.click(); })()');
    check('an event for a row that is gone is not given to the program', await page.evaluate('window.given'), 0);
    await page.click('#create');
    check('and one for a row that is there is', await page.evaluate(
      '(() => { window.given = 0; document.querySelector("tbody tr:nth-child(7) td:nth-child(2) a").click(); return window.given; })()'), 1);
  },

  // next/tests/web/fields.sub: attributes that are there or not and that
  // are numbers, in the page, and messages with their events' data.
  async fields(page) {
    const shown = () => page.evaluate('document.getElementById("shown").textContent');
    const attribute = (id, name) => page.evaluate(`document.getElementById("${id}").getAttribute("${name}")`);
    check('loaded', await shown(), '||0|0');
    check('what stays is the template\'s', await page.evaluate('document.getElementById("field").outerHTML'),
      '<input id="field" type="text" maxlength="12" autofocus="">');
    check('the button is disabled', await attribute('send', 'disabled'), '');
    check('the cell spans one column', await attribute('cell', 'colspan'), '1');
    check('a textarea\'s value, which its HTML has no attribute for, is given it',
      await page.evaluate('document.getElementById("area").value'), 'kept');
    await page.click('#send');
    check('and a click on it is not heard', await shown(), '||0|0');

    await page.click('#field');
    await page.type('abc');
    check('what is typed is the message\'s text', await shown(), 'abc||0|0');
    check('the cell spans as the text is long', await attribute('cell', 'colspan'), '4');
    await page.press('Enter', 8);
    check('a key, with shift', await shown(), 'abc|Enter+shift|0|0');
    await page.press('ArrowUp', 2);
    check('another, with control', await shown(), 'abc|ArrowUp+control|0|0');
    await page.press('ArrowDown');
    check('and one with neither', await shown(), 'abc|ArrowDown|0|0');

    await page.click('#box');
    check('the box, checked, is the message\'s truth: the button is not disabled',
      await attribute('send', 'disabled'), null);
    check('the box is checked', await page.evaluate('document.getElementById("box").checked'), true);
    await page.click('#send');
    check('and its click is heard', await shown(), 'abc|ArrowDown|1|0');
    await page.click('#box');
    check('not checked, it is disabled again', await attribute('send', 'disabled'), '');
    check('the box is not checked', await page.evaluate('document.getElementById("box").checked'), false);

    await page.evaluate('document.getElementById("part").dispatchEvent(new Event("my-event"))');
    check('an event of the page\'s own, named by a string', await shown(), 'abc|ArrowDown|1|1');
  },

  // next/tests/web/focus.sub: an event that a batch's patch causes is
  // handled while the batch is being applied, and the batch is applied
  // once.
  async focus(page) {
    const counts = () => page.evaluate('document.getElementById("counts").textContent');
    const marks = () => page.evaluate('document.querySelectorAll("span.mark").length');
    check('loaded', await counts(), '0 0 0');
    await page.click('#turn');
    check('a turn gives the field the focus, which the program hears', await counts(), '1 1 0');
    check('the field has the focus', await page.evaluate('document.activeElement.id'), 'field');
    check('the batch that gave it was applied once', await marks(), 1);
    // The click takes the focus from the field first, then gives it back.
    await page.click('#turn');
    check('another turn', await counts(), '2 2 1');
    check('one mark still', await marks(), 1);
  },
};

const server = spawn(path.join(here, '../../../host/web/serve.mjs'), [sites, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
try {
  await withBrowser(async (open) => {
    for (const name of names) {
      const before = failed;
      const page = await open(`${url}${name}/index.html`);
      try {
        await page.waitFor('window.ready', 60000);
        await checks[name](page);
      } catch (e) {
        failed++;
        console.log(`FAIL ${name}: ${e.message}`);
      }
      if (failed === before) console.log(`ok   ${name}`);
      else console.log(`--- ${name}'s console\n${page.log.join('\n')}`);
    }
  }, { dir: sites });
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
