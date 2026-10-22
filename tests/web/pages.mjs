// Browser tests: each check opens its page, acts as a user would, and compares.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser, webgpuFlags } from '../../host/web/browser.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const [sites, ...names] = process.argv.slice(2);

let failed = 0;
function check(what, got, expected) {
  if (got === expected) return;
  failed++;
  console.log(`FAIL ${what}\n--- got\n${got}\n--- expected\n${expected}`);
}

const root = 'document.getElementById("root").innerHTML';

const checks = {
  // <!--a--> is the placeholder ui.sub leaves where the optional reset button goes.
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
    const say = async (text) => {
      await page.type(text);
      await page.press('Enter');
      await idle();
    };
    const fieldText = () => page.evaluate('document.querySelector("textarea").value');

    const scheme = '(language scheme "lib/scheme/scheme.sub") => ';
    await idle();
    check('repl: the page starts a Scheme session', await shown(), scheme);
    check('repl: the text box has the focus', await page.evaluate('document.activeElement.tagName'), 'TEXTAREA');

    await say('(define (sq x) (* x x))');
    await say('(sq 7)');
    await say('(car 5)');
    await page.type('(map sq');
    await page.press('Enter');
    await say("     '(1 2 3))");
    await say('(nope)');
    await say('(define (sq x) (* x x x))');
    await say('(sq 3)');
    check('repl: definitions, values and errors in Scheme', await shown(), [
      scheme,
      '(define (sq x) (* x x)) => ',
      '(sq 7) => 49',
      '! (car 5) => error: car: expected a pair, got 5',
      "(map sq\n     '(1 2 3)) => (1 4 9)",
      '! (nope) => input-6:1:2: error: unbound identifier nope',
      '(define (sq x) (* x x x)) => ',
      '(sq 3) => 27',
    ].join('\n'));
    check('repl: the text box is empty after an input', await fieldText(), '');

    await page.press('ArrowUp');
    check('repl: ArrowUp recalls the previous input', await fieldText(), '(sq 3)');
    await page.press('ArrowUp');
    await page.press('ArrowDown');
    await page.press('Enter');
    await idle();
    check('repl: a recalled input can be evaluated again', await last(), '(sq 3) => 27');

    await say('(begin-for-syntax (define (trapping [s i32]) -> i32 (/ s 0)))');
    await say('(define-syntax trap! trapping)');
    await say('(trap! 1)');
    check('repl: a trap in a macro is reported as the input\'s error', (await last()).split(' at ')[0],
      '! (trap! 1) => input-12:1:1: error: trap: divide by zero');
    await say('(sq 2)');
    check('repl: the session still works after the trap', await last(), '(sq 2) => 8');

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

    await page.type('(let loop ([n 0]) (display n) (newline) (loop (+ n 1)))');
    await page.press('Enter');
    await page.waitFor('document.querySelector("section.running .output")?.textContent.includes("more output not shown")', 60000);
    check('repl: output appears while the input is still running',
      (await last()).split('\n').slice(0, 3).join(' '), '~ (let loop ([n 0]) (display n) (newline) (loop (+ n 1))) => 0 1 2');
    check('repl: endless output is cut off with a notice', (await last()).split('\n').pop(), '... (more output not shown)');
    await page.click('button.stop');
    await idle();
    check('repl: Stop ends the printing input', (await last()).split('\n').pop(), 'Stopped.');

    await page.click('nav button:nth-of-type(2)');
    await idle();
    await say('(define (fib [n i32]) -> i32 (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))');
    await say('(+ (fib 20) 0.5)');
    await say('(sq 2)');
    check('repl: a session in Substrate', await shown(), [
      '(language substrate "compiler/substrate.sub") => ',
      '(define (fib [n i32]) -> i32 (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) => ',
      '(+ (fib 20) 0.5) => 6765.5',
      '! (sq 2) => input-20:1:2: error: unbound identifier sq',
    ].join('\n'));
    check('repl: the text box has the focus after a language button',
      await page.evaluate('document.activeElement.tagName'), 'TEXTAREA');

    await page.type('(memset (cast (ptr void) 8) 255 (cast u32 (- (sbrk 0) 8)))');
    await page.press('Enter');
    await idle();
    check('repl: an input that corrupts the session fails', (await last()).split('\n')[0],
      '! (memset (cast (ptr void) 8) 255 (cast u32 (- (sbrk 0) 8))) => 8');
    check('repl: the page reports that the session crashed', (await last()).split('\n').pop(),
      'The session crashed while evaluating this input. A new session was started.');
    await say('(fib 10)');
    check('repl: earlier definitions survive the crash', await last(), '(fib 10) => 55');

    await page.click('nav button.quiet');
    check('repl: Clear empties the page', await shown(), '');
    await say('(fib 11)');
    check('repl: Clear keeps the session', await shown(), '(fib 11) => 89');

    await page.click('nav button:nth-of-type(3)');
    await idle();
    check('repl: the URL carries the language', await page.evaluate('location.search'), '?language=bend');
    await page.evaluate('location.href = location.pathname + "?language=substrate"');
    await page.waitFor('window.ready && location.search === "?language=substrate"', 20000);
    await idle();
    check('repl: a language in the URL opens that session', await shown(), '(language substrate "compiler/substrate.sub") => ');

    await say('(define (sq [x i32]) -> i32 (* x x))');
    await say('(sq 4)');
    const downloads = path.resolve(sites, 'repl-downloads');
    fs.rmSync(downloads, { recursive: true, force: true });
    fs.mkdirSync(downloads);
    await page.downloadsTo(downloads);
    await page.click('#save');
    const saved = path.join(downloads, 'session.sub');
    for (let i = 0; i < 100 && !fs.existsSync(saved); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    check('repl: Save downloads the inputs as a session file', fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : 'no file',
      '(language substrate "compiler/substrate.sub")\n\n(define (sq [x i32]) -> i32 (* x x))\n\n(sq 4)\n');

    const forms = path.join(downloads, 'forms.sub');
    fs.writeFileSync(forms, '(define (cube [x i32]) -> i32\n  (* x x x))\n\n(cube 3)\n');
    await page.chooseFiles([forms]);
    await page.click('#load');
    await page.waitFor('document.querySelectorAll("section.entry").length === 5', 20000);
    await idle();
    check('repl: Load evaluates a file\'s forms in turn', (await entries()).slice(3).join('\n'),
      '(define (cube [x i32]) -> i32\n  (* x x x)) => \n(cube 3) => 27');

    await page.grant(['clipboardReadWrite', 'clipboardSanitizedWrite']);
    await page.command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.click('#copy');
    const transcript = await page.evaluate(`[...document.querySelectorAll('section.entry')].map((s) => {
      const output = s.querySelector('.output');
      return s.querySelector('.input').textContent + '\\n'
        + (output ? output.textContent.split('\\n').map((l) => ';; ' + l).join('\\n') + '\\n' : '');
    }).join('\\n')`);
    await page.waitFor('navigator.clipboard.readText().then((t) => t !== "")', 10000);
    check('repl: Copy puts the transcript on the clipboard, outputs as comments',
      await page.evaluate('navigator.clipboard.readText()'), transcript);

    await page.type('(sq 1');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.evaluate('window.ready = false; location.reload()');
    await page.waitFor('window.ready', 20000);
    await idle();
    check('repl: the draft survives a reload', await fieldText(), '(sq 1');
    check('repl: and the language is the URL\'s', await shown(), '(language substrate "compiler/substrate.sub") => ');
  },

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

    await page.evaluate('window.kept = document.querySelector("tbody tr:nth-child(7) td:nth-child(2) a")');
    await page.click('#clear');
    same('rows: clear removes every row', await ids(), []);
    check('rows: clear leaves only the placeholder node', await page.evaluate('document.querySelector("tbody").childNodes.length'), 1);
    const delivered = (click) => page.evaluate(`(() => {
      const before = window.app.host.deliveries;
      ${click};
      return window.app.host.deliveries - before;
    })()`);
    check('rows: a click on a removed row does not reach the program', await delivered('window.kept.click()'), 0);
    await page.click('#create');
    check('rows: a click on a current row reaches the program once',
      await delivered('document.querySelector("tbody tr:nth-child(7) td:nth-child(2) a").click()'), 1);
  },

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
    // press's second argument is the modifier keys: 8 is Shift, 2 is Control.
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

  async guests(page) {
    const log = async () => (await page.evaluate('document.getElementById("log").textContent'))
      .split('\n').filter((l) => !l.startsWith('    ')).join('\n');
    await page.waitFor('document.getElementById("log").textContent.includes("guest 3 is now looping")', 30000);
    await page.click('#tick');
    await page.click('#tick');
    check('guests: the page responds while a guest loops forever', await page.evaluate('document.getElementById("ticks").textContent'), '2');
    await page.click('#stop');
    await page.waitFor('document.getElementById("log").textContent.endsWith("finished\\n")');
    check('guests: the log of events', await log(), [
      '1 stdout: a guest, one, two words',
      '1 done',
      '1 message: total 5',
      '1 done',
      '1 message: total 42',
      '1 done',
      '1 stdout: hello',
      '1 message: said',
      '1 done',
      '1 stderr: careful',
      '1 message: warned',
      '1 done',
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
      '1 message: trapped: trap: divide by zero',
      '1 done: trap: divide by zero',
      '1 message: total 43',
      '1 done',
      '1 message: no guest: guest.start: a guest cannot start guests of its own',
      '1 done',
      '1 message: out of memory before 32 MiB',
      '1 done',
      '1 message: total 44',
      '1 done',
      '1 ended: exit 3',
      'send to guest 1 returned -1',
      '2 stdout: a guest',
      '2 done',
      '2 ended: time limit exceeded (300 ms)',
      '3 stdout: a guest',
      '3 done',
      '3 message: total 2',
      'guest 3 is now looping',
      '3 done',
      'stopped guest 3; send to it returned -1',
      'no guest: guest.start: no program found in /nowhere',
      'no guest: guest.start: unknown setting "frobnicate" in the spec',
      'no guest: guest.start: "time" needs a positive whole number, not "soon"',
      'finished',
      '',
    ].join('\n'));
    check('guests: a file written by a guest does not appear in the page\'s files',
      await page.evaluate('window.app.files.has("/out/made.txt")'), false);
  },

  async canvas(page) {
    const shown = () => page.evaluate('document.getElementById("shown").textContent');
    const pixel = (x, y) => page.evaluate(
      `[...document.getElementById("board").getContext("2d").getImageData(${x}, ${y}, 1, 1).data].join(",")`);
    const frames = async () => Number((await shown()).match(/frames (\d+)/)[1]);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    check('canvas: initial page', await shown(), '0,0 clicks 0 frames 0 keys 0');
    check('canvas: the canvas is painted white when it is created', await pixel(100, 50), '255,255,255,255');

    // page.click clicks the middle of the element: (100, 50) on a canvas of 200 by 100.
    await page.click('#board');
    check('canvas: a click reports the mouse position', await shown(), '100,50 clicks 1 frames 0 keys 0');
    check('canvas: the square is drawn where the click was', await pixel(100, 50), '255,0,0,255');
    check('canvas: the rest of the canvas is still white', await pixel(20, 20), '255,255,255,255');

    await page.press('a');
    await sleep(100);
    check('canvas: nothing listens before the label is shown', await shown(), '100,50 clicks 1 frames 0 keys 0');

    await page.click('#toggle');
    await page.waitFor('Number(document.getElementById("shown").textContent.match(/frames (\\d+)/)[1]) >= 3');
    await page.press('a');
    await page.press('ArrowUp');
    check('canvas: a window listener hears keys without any element having the focus',
      (await shown()).match(/keys (\d+)/)[1], '2');
    check('canvas: frames do not redraw the canvas, whose draw key did not change', await pixel(100, 50), '255,0,0,255');

    await page.click('#toggle');
    const before = await frames();
    await sleep(150);
    await page.press('a');
    check('canvas: frames stop when the element is removed', await frames(), before);
    check('canvas: keys stop when the element is removed', (await shown()).match(/keys (\d+)/)[1], '2');

    await page.click('#toggle');
    await page.waitFor(`Number(document.getElementById("shown").textContent.match(/frames (\\d+)/)[1]) > ${before}`);
    await page.press('a');
    check('canvas: the listeners work again when the element comes back', (await shown()).match(/keys (\d+)/)[1], '3');
  },

  async snake(page) {
    const text = (id) => page.evaluate(`document.getElementById("${id}").textContent`);
    const cell = (x, y) => page.evaluate(
      `[...document.getElementById("board").getContext("2d").getImageData(${x * 20 + 10}, ${y * 20 + 10}, 1, 1).data].join(",")`);
    const head = '180,241,167,255';
    const body = '87,171,90,255';
    const empty = '16,20,26,255';
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    check('snake: a new game waits for a key', await text('status'), 'Press an arrow key to start.');
    check('snake: the head is drawn', await cell(10, 10), head);
    check('snake: the body is drawn', await cell(9, 10), body);
    check('snake: the score starts at 0', await text('score'), '0');

    await page.press('ArrowRight');
    check('snake: an arrow key starts the game', await text('status'), 'Arrow keys or W A S D to turn. Space to pause.');
    await page.waitFor(`(() => {
      const d = document.getElementById("board").getContext("2d").getImageData(10 * 20 + 10, 10 * 20 + 10, 1, 1).data;
      return d[0] === 16 && d[1] === 20;
    })()`, 5000);
    check('snake: the snake has moved, and left its old cells', await cell(10, 10), empty);

    await page.press(' ');
    check('snake: Space pauses', await text('status'), 'Paused. Press Space to continue.');
    await page.press(' ');
    check('snake: Space continues', await text('status'), 'Arrow keys or W A S D to turn. Space to pause.');

    await page.waitFor('document.getElementById("status").textContent.startsWith("Game over")', 10000);
    check('snake: the game ends at the wall', await text('status'), 'Game over. Press Enter to play again.');
    await page.press('ArrowLeft');
    check('snake: arrow keys do not restart a finished game', await text('status'), 'Game over. Press Enter to play again.');

    await page.press('Enter');
    check('snake: Enter starts a new game', await text('status'), 'Press an arrow key to start.');
    check('snake: the new snake is back in the middle', await cell(10, 10), head);
    await page.click('#new-game');
    check('snake: the button starts a new game too', await text('status'), 'Press an arrow key to start.');
    await page.press('a');
    check('snake: the A key turns left and starts the game', await text('status'), 'Arrow keys or W A S D to turn. Space to pause.');

    await page.evaluate(`new Promise((resolve) => {
      const r = indexedDB.open('snake', 1);
      r.onsuccess = () => {
        const t = r.result.transaction('keys', 'readwrite');
        t.objectStore('keys').put(new TextEncoder().encode('42'), 'best');
        t.oncomplete = resolve;
      };
    })`);
    await page.evaluate('window.ready = false; location.reload()');
    await page.waitFor('window.ready && document.getElementById("best").textContent === "42"', 20000);
    check('snake: the best score is kept across reloads', await text('best'), '42');
  },

  async platformer(page) {
    const pixel = (x, y) => page.evaluate(
      `window.gpuModule.readSurface(1, ${x}, ${y}, 1, 1).then((p) => Array.from(p).join(","))`);
    const sky = '143,211,255,255';
    const dirt = '160,103,63,255';
    const shirt = '83,155,245,255';
    await page.waitFor(`window.gpuModule.readSurface(1, 8, 170, 1, 1).then((p) => p[0] === 160 && p[1] === 103)`, 10000);
    check('platformer: the ground is drawn from the sprite sheet', await pixel(8, 170), dirt);
    check('platformer: the sky is drawn', await pixel(100, 100), sky);
    check('platformer: the player is drawn where the level puts it', await pixel(40, 140), shirt);
    check('platformer: the text is drawn on the overlay', await page.evaluate(`(() => {
      const d = document.querySelectorAll("canvas")[1].getContext("2d").getImageData(0, 0, 160, 16).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n > 100;
    })()`), true);
    check('platformer: the sprite sheet is downloaded only once', await page.evaluate(
      'performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/assets/sprites.png")).length'), 1);
    check('platformer: the screen has 320 by 180 pixels',
      await page.evaluate('(() => { const c = document.querySelector("canvas"); return c.width + "x" + c.height; })()'), '320x180');
    check('platformer: the screen is stretched to the window, keeping its shape', await page.evaluate(`(() => {
      const c = document.querySelector("canvas");
      return c.clientWidth > 320 && Math.abs(c.clientWidth / c.clientHeight - 320 / 180) < 0.01;
    })()`), true);
    check('platformer: the overlay lies exactly over the screen', await page.evaluate(`(() => {
      const [a, b] = document.querySelectorAll("canvas");
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.left === rb.left && ra.top === rb.top && ra.width === rb.width && ra.height === rb.height;
    })()`), true);

    await page.keyDown('ArrowRight');
    await page.waitFor(`window.gpuModule.readSurface(1, 40, 140, 1, 1).then((p) => p[0] === 143 && p[1] === 211)`, 5000);
    check('platformer: holding the right arrow moves the player away', await pixel(40, 140), sky);
    await page.keyUp('ArrowRight');

    const before = await page.evaluate('window.audio.played()');
    await page.press(' ');
    await page.waitFor(`window.audio.played() > ${before}`, 5000);
    check('platformer: a jump plays a sound', (await page.evaluate('window.audio.played()')) > before, true);
  },

  async gpu(page) {
    const shown = (id) => page.evaluate(`document.getElementById("${id}").textContent`);
    await page.waitFor('document.getElementById("pixels").textContent !== "waiting"', 10000);
    await page.waitFor('document.getElementById("numbers").textContent !== "waiting"', 10000);
    await page.waitFor('document.getElementById("errors").textContent !== ""', 10000);
    check('gpu: the rectangles are in the texture', await shown('pixels'), '3,3: 255,0,0,255  11,11: 0,255,0,255  0,0: 0,0,0,0');
    check('gpu: the compute shader doubled the numbers', await shown('numbers'), '2,4,6,8,10,12,14,16');
    check('gpu: the broken shader reports its error', await shown('errors'),
      "[3] shader 3 does not compile:\n  line 1, column 12: expected ')' for function declaration\n  line 1, column 13: expected '}' for function body\n");
    check('gpu: nothing is written to the console', page.log.join('\n'), '');
  },

  async sprites(page) {
    await page.evaluate('location.search = "?n=1"');
    await page.waitFor('window.ready && location.search === "?n=1"', 20000);
    const pixel = (x, y) => page.evaluate(`window.gpuModule.readSurface(1, ${x}, ${y}, 1, 1).then((p) => Array.from(p).join(","))`);
    await page.waitFor('window.gpuModule.readSurface(1, 11, 13, 1, 1).then((p) => p[0] === 160 && p[1] === 103)', 10000);
    check('sprites: the GPU draws the sprite', await pixel(11, 13), '160,103,63,255');
    check('sprites: the GPU draws its top rows', await pixel(8, 8), '87,171,90,255');
    check('sprites: the GPU fills the background', await pixel(300, 200), '143,211,255,255');
    check('sprites: the GPU draws nothing outside the sprite', await pixel(7, 7), '143,211,255,255');
    check('sprites: nothing is written to the console', page.log.join('\n'), '');
  },
  async 'sprites-canvas'(page) {
    await page.evaluate('location.search = "?n=1"');
    await page.waitFor('window.ready && location.search === "?n=1"', 20000);
    const pixel = (x, y) => page.evaluate(
      `[...document.querySelector("canvas").getContext("2d").getImageData(${x}, ${y}, 1, 1).data].join(",")`);
    await page.waitFor('(() => { const d = document.querySelector("canvas").getContext("2d").getImageData(11, 13, 1, 1).data; return d[0] === 160 && d[1] === 103; })()', 10000);
    check('sprites-canvas: the canvas draws the sprite', await pixel(11, 13), '160,103,63,255');
    check('sprites-canvas: the canvas draws its top rows', await pixel(8, 8), '87,171,90,255');
    check('sprites-canvas: the canvas fills the background', await pixel(300, 200), '143,211,255,255');
    check('sprites-canvas: the canvas draws nothing outside the sprite', await pixel(7, 7), '143,211,255,255');
    check('sprites-canvas: nothing is written to the console', page.log.join('\n'), '');
  },

  async blocks(page) {
    const picture = () => page.evaluate(`window.gpuModule.readSurface(1, 0, 120, 640, 120).then((p) => { let s = 0; for (let i = 0; i < p.length; i += 4) s = (s * 31 + p[i] + p[i + 1] * 3) % 1000000007; return s; })`);
    const pixel = (x, y) => page.evaluate(`window.gpuModule.readSurface(1, ${x}, ${y}, 1, 1).then((p) => Array.from(p).join(","))`);
    await page.waitFor('window.gpuModule.readSurface(1, 320, 340, 1, 1).then((p) => p[0] > 40)', 10000);
    const top = (await pixel(320, 20)).split(',').map(Number);
    check('blocks: the sky is at the top, blue', top[2] > 200 && top[2] >= top[1] && top[1] > top[0], true);
    const ground = (await pixel(320, 340)).split(',').map(Number);
    check('blocks: the land is at the bottom, not the sky', ground[2] < 150 && ground[3] === 255, true);
    const greens = await page.evaluate(`window.gpuModule.readSurface(1, 0, 60, 640, 300).then((p) => {
      let lit = 0, shaded = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i + 1] > p[i] + 40 && p[i + 1] > p[i + 2] + 40) { if (p[i + 1] > 150) lit++; else if (p[i + 1] > 50) shaded++; }
      }
      return [lit, shaded];
    })`);
    check('blocks: the sun lights some grass and leaves some in shade', greens[0] > 5000 && greens[1] > 5000, true);
    await page.keyDown('ArrowLeft');
    await new Promise((resolve) => setTimeout(resolve, 430));
    await page.keyUp('ArrowLeft');
    await page.keyDown('ArrowUp');
    await new Promise((resolve) => setTimeout(resolve, 330));
    await page.keyUp('ArrowUp');
    await page.waitFor(`window.gpuModule.readSurface(1, 0, 0, 640, 240).then((p) => { for (let i = 0; i < p.length; i += 4) if (p[i] >= 252 && p[i + 1] >= 252 && p[i + 2] >= 252) return true; return false; })`, 5000);
    check('blocks: the sun is in the sky', true, true);
    await page.keyDown('ArrowDown');
    await new Promise((resolve) => setTimeout(resolve, 330));
    await page.keyUp('ArrowDown');
    await page.keyDown('ArrowRight');
    await new Promise((resolve) => setTimeout(resolve, 430));
    await page.keyUp('ArrowRight');
    await new Promise((resolve) => setTimeout(resolve, 100));
    check('blocks: the text is drawn on the overlay', await page.evaluate(`(() => {
      const d = document.querySelectorAll("canvas")[1].getContext("2d").getImageData(0, 0, 200, 40).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n > 100;
    })()`), true);
    const before = await picture();
    await page.keyDown('w');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.keyUp('w');
    await page.waitFor(`window.gpuModule.readSurface(1, 0, 120, 640, 120).then((p) => { let s = 0; for (let i = 0; i < p.length; i += 4) s = (s * 31 + p[i] + p[i + 1] * 3) % 1000000007; return s !== ${before}; })`, 5000);
    check('blocks: walking changes the view', (await picture()) !== before, true);
    await page.keyDown('ArrowDown');
    await new Promise((resolve) => setTimeout(resolve, 700));
    await page.keyUp('ArrowDown');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const looking = await picture();
    await page.press('x');
    await page.waitFor(`window.gpuModule.readSurface(1, 0, 120, 640, 120).then((p) => { let s = 0; for (let i = 0; i < p.length; i += 4) s = (s * 31 + p[i] + p[i + 1] * 3) % 1000000007; return s !== ${looking}; })`, 5000);
    check('blocks: digging changes the view', (await picture()) !== looking, true);

    const dug = await picture();
    await page.click('canvas');
    await page.waitFor('document.pointerLockElement !== null', 5000);
    check('blocks: a click locks the pointer to the screen', await page.evaluate('document.pointerLockElement && document.pointerLockElement.tagName'), 'CANVAS');
    await page.waitFor(`(window.dispatchEvent(new MouseEvent('mousemove', { movementX: 30, movementY: 0 })),
      window.gpuModule.readSurface(1, 0, 120, 640, 120).then((p) => { let s = 0; for (let i = 0; i < p.length; i += 4) s = (s * 31 + p[i] + p[i + 1] * 3) % 1000000007; return s !== ${dug}; }))`, 5000);
    check('blocks: moving the mouse turns the view', (await picture()) !== dug, true);
    const turned = await picture();
    await page.evaluate(`document.querySelector('canvas').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))`);
    await page.waitFor(`window.gpuModule.readSurface(1, 0, 120, 640, 120).then((p) => { let s = 0; for (let i = 0; i < p.length; i += 4) s = (s * 31 + p[i] + p[i + 1] * 3) % 1000000007; return s !== ${turned}; })`, 5000);
    check('blocks: the left button digs', (await picture()) !== turned, true);
    await page.evaluate('document.exitPointerLock()');
    await page.waitFor('document.pointerLockElement === null', 5000);
    check('blocks: the game has not stopped', await page.evaluate('document.querySelector(".game-stopped") === null'), true);
    check('blocks: nothing is written to the console', page.log.join('\n'), '');
  },

  async valley(page) {
    const pixel = (x, y) => page.evaluate(`window.gpuModule.readSurface(1, ${x}, ${y}, 1, 1).then((p) => Array.from(p).join(","))`);
    const count = (x, y, w, h, test) => page.evaluate(`window.gpuModule.readSurface(1, ${x}, ${y}, ${w}, ${h}).then((p) => {
      let n = 0;
      for (let i = 0; i < p.length; i += 4) { const r = p[i], g = p[i + 1], b = p[i + 2]; if (${test}) n++; }
      return n;
    })`);
    const picture = () => page.evaluate(`window.gpuModule.readSurface(1, 0, 120, 640, 120).then((p) => { let s = 0; for (let i = 0; i < p.length; i += 4) s = (s * 31 + p[i] + p[i + 1] * 3) % 1000000007; return s; })`);
    await page.waitFor('window.gpuModule.readSurface(1, 100, 330, 1, 1).then((p) => p[1] > 60)', 15000);
    const top = (await pixel(320, 10)).split(',').map(Number);
    check('valley: the sky is at the top, blue', top[2] > 200 && top[2] >= top[1] && top[1] > top[0], true);
    const atLeast = (n, least) => (n >= least ? true : n);
    check('valley: the meadow is at the left, green (20,000 pixels)', atLeast(await count(0, 180, 300, 180, 'g > r + 30 && g > b + 30'), 20000), true);
    check('valley: the river is at the right, blue (10,000 pixels)', atLeast(await count(400, 200, 240, 160, 'b > r + 30 && g > r'), 10000), true);
    check('valley: the bridge is ahead, wooden (100 brown pixels)', atLeast(await count(300, 170, 340, 60, 'r > g && g > b && r - b > 15'), 100), true);
    const tunic = () => count(270, 150, 100, 150, 'b > r + 50 && b > g + 20 && b > 120');
    check('valley: the character is seen from behind (300 blue pixels)', atLeast(await tunic(), 300), true);
    await page.keyDown('v');
    await page.keyUp('v');
    await page.waitFor(`window.gpuModule.readSurface(1, 270, 150, 100, 150).then((p) => { let n = 0; for (let i = 0; i < p.length; i += 4) if (p[i + 2] > p[i] + 50 && p[i + 2] > p[i + 1] + 20 && p[i + 2] > 120) n++; return n < 50; })`, 30000);
    check('valley: through its eyes, the character is not seen', (await tunic()) < 50, true);
    await page.keyDown('v');
    await page.keyUp('v');
    const before = await picture();
    await page.keyDown('w');
    await page.waitFor(`window.gpuModule.readSurface(1, 0, 120, 640, 120).then((p) => { let s = 0; for (let i = 0; i < p.length; i += 4) s = (s * 31 + p[i] + p[i + 1] * 3) % 1000000007; return s !== ${before}; })`, 30000);
    await page.keyUp('w');
    check('valley: walking changes the view', (await picture()) !== before, true);
    await page.evaluate('window.app.call("look", 146, 120, -2.2, 0.1)');
    await page.waitFor(`window.gpuModule.readSurface(1, 0, 240, 640, 100).then((p) => { let n = 0; for (let i = 0; i < p.length; i += 4) if (p[i + 2] > p[i] + 30) n++; return n > 40000; })`, 30000);
    check('valley: from the lake, water fills the lower picture (40,000 pixels)', atLeast(await count(0, 240, 640, 100, 'b > r + 30'), 40000), true);
    check('valley: the game has not stopped', await page.evaluate('document.querySelector(".game-stopped") === null'), true);
    check('valley: nothing is written to the console', page.log.join('\n'), '');
  },

  async sounds(page) {
    const count = (what) => page.evaluate(`window.audio.${what}()`);
    await page.waitFor(`(() => {
      const d = document.querySelector("canvas").getContext("2d").getImageData(10, 10, 1, 1).data;
      return d[0] === 46 && d[1] === 125;
    })()`, 10000);
    check('sounds: one sound file was loaded and decoded', await count('loaded'), 1);
    check('sounds: the file that is missing is reported',
      page.log.some((line) => line.includes('audio: cannot load the sound assets/nothing.wav')), true);
    check('sounds: nothing plays before a key is pressed', await count('started'), 0);
    await page.press('x');
    await page.waitFor('window.audio.running()', 5000);
    await page.waitFor('window.audio.started() === 1', 5000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    check('sounds: the music started with the first key press, and keeps playing', await count('playing'), 1);
    await page.press('s');
    await page.waitFor('window.audio.playing() === 0', 5000);
    check('sounds: S stopped the music', await count('started'), 1);

    await page.press(' ');
    await page.waitFor('window.audio.started() === 2', 5000);
    await page.waitFor('window.audio.playing() === 0', 5000);
    check('sounds: Space played the sound once', await count('started'), 2);

    await page.press('m');
    await page.waitFor('window.audio.started() === 3 && window.audio.playing() === 1', 5000);
    await page.press('s');
    await page.waitFor('window.audio.playing() === 0', 5000);
    check('sounds: M started the music again and S stopped it', await count('started'), 3);
  },

  async stopped(page) {
    await page.waitFor('document.querySelector(".game-stopped pre") !== null', 10000);
    const report = await page.evaluate('document.querySelector(".game-stopped pre").textContent');
    check('stopped: the report starts with the message of the trap',
      report.split('\n')[0], 'trap: vector-at: there is no item 5: the vector holds 1');
    check('stopped: the report lists the game function that was running, and where it is',
      /step! .*tests\/web\/stopped\.sub:13:/.test(report), true);
    check('stopped: the screen keeps what was drawn before the trap', await page.evaluate(
      '[...document.querySelector("canvas").getContext("2d").getImageData(10, 10, 1, 1).data].join(",")'), '46,125,50,255');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check('stopped: there is one report', await page.evaluate('document.querySelectorAll(".game-stopped").length'), 1);
    check('stopped: nothing is written to the console', page.log.join('\n'), '');
  },

  async 'stopped-at-start'(page) {
    await page.waitFor('document.querySelector(".game-stopped pre") !== null', 10000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const report = await page.evaluate('document.querySelector(".game-stopped pre").textContent');
    check('stopped-at-start: the report has the message of the trap in init',
      report.split('\n')[0], 'trap: the level file assets/levels/1.txt is missing');
    check('stopped-at-start: nothing is written to the console', page.log.join('\n'), '');
  },

  async assets(page) {
    const text = (id) => page.evaluate(`document.getElementById("${id}").textContent`);
    const pixel = (x, y) => page.evaluate(
      `[...document.getElementById("board").getContext("2d").getImageData(${x}, ${y}, 1, 1).data].join(",")`);
    check('assets: a text asset is read as a file', await text('note'), 'An asset, read as a file.');
    check('assets: and so is one in a folder, with "#" and a space in its name', await text('nested'), 'An asset in a folder.');
    check('assets: a file that is not among the assets cannot be read', await text('missing'), 'no such file');
    check('assets: a file the program wrote is read back', await text('written'), 'written and read back');
    await page.waitFor(`(() => {
      const d = document.getElementById("board").getContext("2d").getImageData(8, 8, 1, 1).data;
      return d[0] === 255 && d[1] === 0;
    })()`, 10000);
    check('assets: an image asset is drawn', await pixel(8, 8), '255,0,0,255');
    check('assets: and only where it was drawn', await pixel(2, 2), '255,255,255,255');
    await page.waitFor('document.getElementById("picture").complete', 10000);
    check('assets: an image asset is shown by its URL', await page.evaluate('document.getElementById("picture").naturalWidth'), 4);
  },

  async storage(page) {
    await page.waitFor('document.getElementById("step").textContent === "6"', 10000);
    check('storage: set, got, a missing key, listed, removed, gone', await page.evaluate('document.getElementById("log").textContent'),
      '2 0 \n1 1 hello\n1 0 \n3 1 greeting\n\n2 0 \n1 0 \n');
  },

  async location(page) {
    const text = (id) => page.evaluate(`document.getElementById("${id}").textContent`);
    const first = `${url}location/index.html`;
    await page.waitFor('document.getElementById("back").textContent !== ""', 10000);
    check('location: the URL', await text('first'), first);
    check('location: after a push', await text('pushed'), `${first}?page=2`);
    check('location: back again, as an event', await text('back'), first);
  },

  async clipboard(page) {
    await page.grant(['clipboardReadWrite', 'clipboardSanitizedWrite']);
    await page.command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.click('#copy');
    await page.waitFor('document.getElementById("shown").textContent !== "waiting"', 10000);
    check('clipboard: text written, then read back', await page.evaluate('document.getElementById("shown").textContent'),
      'read: copied text');
  },

  async files(page) {
    const text = (id) => page.evaluate(`document.getElementById("${id}").textContent`);
    const picked = [path.join(here, '../events/files/hello.txt'), path.join(here, 'assets/note.txt')];
    await page.chooseFiles(picked);
    await page.click('#pick');
    await page.waitFor('document.getElementById("picked").textContent === "2" && document.getElementById("shown").textContent.split("\\n").length === 3', 10000);
    check('files: two files picked, each read whole, in turn', await text('shown'),
      picked.map((p) => `${path.basename(p)} ${fs.statSync(p).size} ${fs.readFileSync(p, 'utf8')}\n`).join(''));
    const downloads = path.resolve(sites, 'files-downloads');
    fs.rmSync(downloads, { recursive: true, force: true });
    fs.mkdirSync(downloads);
    await page.downloadsTo(downloads);
    await page.click('#save');
    const saved = path.join(downloads, 'saved.txt');
    for (let i = 0; i < 100 && !fs.existsSync(saved); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    check('files: bytes saved as a download', fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : 'no file', 'saved bytes');
  },

  async floor(page) {
    const shown = (id) => page.evaluate(`document.getElementById("${id}").textContent`);
    await page.waitFor('document.getElementById("fired").textContent === "1" && document.getElementById("text").textContent !== ""', 10000);
    check('floor: the timer fired once', await shown('fired'), '1');
    check('floor: the asset was fetched', await shown('text'), 'An asset, read as a file.');
    check('floor: with the status 200', await shown('status'), '200');
    check('floor: nothing is written to the console', page.log.join('\n'), '');
  },

  async focus(page) {
    const counts = () => page.evaluate('document.getElementById("counts").textContent');
    const marks = () => page.evaluate('document.querySelectorAll("span.mark").length');
    check('focus: initial page', await counts(), '0 0 0');
    await page.click('#turn');
    check('focus: the program receives the focus event', await counts(), '1 1 0');
    check('focus: the field has the focus', await page.evaluate('document.activeElement.id'), 'field');
    check('focus: the update was applied once', await marks(), 1);
    await page.click('#turn');
    check('focus: second click', await counts(), '2 2 1');
    check('focus: still one mark', await marks(), 1);
  },
};

const needsGpu = new Set(['gpu', 'sprites', 'platformer', 'blocks', 'valley']);

// Port 0: any free port.
const server = spawn(path.join(here, '../../bin/sub'), ['serve', sites, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
async function run(group) {
  await withBrowser(async (open) => {
    for (const name of group) {
      const before = failed;
      const page = await open(`${url}${name}/index.html`);
      try {
        // Each page sets window.ready once its program has started.
        await page.waitFor('window.ready', 60000);
        await checks[name](page);
      } catch (e) {
        failed++;
        console.log(`FAIL ${name}: ${e.message}`);
      }
      if (failed === before) console.log(`ok   ${name}`);
      else console.log(`--- browser console of ${name}\n${page.log.join('\n')}`);
    }
  }, needsGpu.has(group[0]) ? { dir: sites, gpu: true, flags: webgpuFlags } : { dir: sites });
}
try {
  const plain = names.filter((n) => !needsGpu.has(n));
  const gpu = names.filter((n) => needsGpu.has(n));
  if (plain.length) await run(plain);
  if (gpu.length) await run(gpu);
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
