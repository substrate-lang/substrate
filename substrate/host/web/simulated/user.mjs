// Turns what a user does in the simulated browser into the events a browser sends, with their default effects on text
// fields, buttons, checkboxes and the focus.
import { Event, focusable } from './document.mjs';
import { codeOf, modifiers, parseKey } from '../testing/keys.mjs';

const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export function user(document, window) {
  const down = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
  const target = () => document.activeElement || document.body;
  const textField = (e) => e.localName === 'textarea' || (e.localName === 'input' && textTypes.has(e.type));
  const disabled = (e) => ['button', 'input', 'select', 'textarea'].includes(e.localName)
    && (e.hasAttribute('disabled') || !!e.closest('fieldset[disabled]'));

  const key = (e, type, name, held) => {
    if (type === 'keydown' && name !== 'Escape') document.activated = document.hooks.now();
    return e.dispatchEvent(new Event(type, {
      bubbles: true, cancelable: true, key: name, code: codeOf(name), repeat: false, view: window, ...down, ...held,
    }));
  };

  const insert = (e, s) => {
    if (!textField(e) || e.hasAttribute('readonly') || disabled(e)) return;
    const room = e.maxLength < 0 ? s.length : Math.max(0, e.maxLength - e.value.length);
    const added = s.slice(0, room);
    if (added === '') return;
    e.value += added;
    e.dispatchEvent(new Event('input', { bubbles: true, inputType: 'insertText', data: added }));
  };

  const removeLast = (e) => {
    if (!textField(e) || e.value === '' || e.hasAttribute('readonly') || disabled(e)) return;
    e.value = [...e.value].slice(0, -1).join('');
    e.dispatchEvent(new Event('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  };

  const activates = (e) => e.localName === 'button' || (e.localName === 'a' && e.hasAttribute('href'))
    || (e.localName === 'input' && ['button', 'submit', 'reset', 'image'].includes(e.type));

  const tab = (back) => {
    const all = document.body.querySelectorAll('*').filter((e) => focusable(e) && e.getAttribute('tabindex') !== '-1');
    if (all.length === 0) return;
    const k = all.indexOf(document.activeElement);
    const next = k < 0 ? (back ? all.length - 1 : 0) : (k + (back ? all.length - 1 : 1)) % all.length;
    all[next].focus();
  };

  const typed = (e, name, held) => {
    if (held.ctrlKey || held.metaKey || held.altKey) return;
    if (name === 'Enter') {
      if (e.localName === 'textarea') insert(e, '\n');
      else if (activates(e)) document.clickOn(e, { detail: 0 });
    } else if (name === 'Backspace') {
      removeLast(e);
    } else if (name === 'Tab') {
      tab(!!held.shiftKey);
    } else if ([...name].length === 1 && (name !== ' ' || textField(e))) {
      e.dispatchEvent(new Event('keypress', { bubbles: true, cancelable: true, key: name, code: codeOf(name), view: window, ...down, ...held }));
      insert(e, name);
    }
  };

  const press = (name, held) => {
    const e = target();
    if (modifiers[name]) {
      key(e, 'keydown', name, held);
      key(e, 'keyup', name, held);
      return;
    }
    if (key(e, 'keydown', name, held)) typed(e, name, held);
    const up = key(target(), 'keyup', name, held);
    const now = target();
    if (up && name === ' ' && !textField(now) && (activates(now) || (now.localName === 'input' && ['checkbox', 'radio'].includes(now.type)))) {
      document.clickOn(now, { detail: 0 });
    }
  };

  const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const where = (e, at) => {
    const [x, y] = at || (e.localName === 'canvas' ? [e.width / 2, e.height / 2] : [0, 0]);
    return { offsetX: x, offsetY: y, clientX: x, clientY: y, view: window, ...down };
  };

  // moveTo moves the mouse over e, with the events a browser sends as the mouse leaves one element and enters another.
  // A locked pointer stays where it is.
  const moveTo = (e, at) => {
    if (document.pointerLockElement) return;
    const mouse = { button: 0, buttons: 0, ...where(e, at) };
    const old = document.hovered && document.hovered.isConnected ? document.hovered : null;
    if (old !== e) {
      if (old) {
        old.dispatchEvent(new Event('pointerout', { bubbles: true, relatedTarget: e, ...mouse, ...pointer }));
        old.dispatchEvent(new Event('mouseout', { bubbles: true, cancelable: true, relatedTarget: e, ...mouse }));
        for (let n = old; n && n.nodeType === 1 && !n.contains(e); n = n.parentNode) {
          n.dispatchEvent(new Event('pointerleave', { relatedTarget: e, ...mouse, ...pointer }));
          n.dispatchEvent(new Event('mouseleave', { relatedTarget: e, ...mouse }));
        }
      }
      document.hovered = e;
      e.dispatchEvent(new Event('pointerover', { bubbles: true, relatedTarget: old, ...mouse, ...pointer }));
      e.dispatchEvent(new Event('mouseover', { bubbles: true, cancelable: true, relatedTarget: old, ...mouse }));
      const entered = [];
      for (let n = e; n && n.nodeType === 1 && !(old && n.contains(old)); n = n.parentNode) entered.unshift(n);
      for (const n of entered) {
        n.dispatchEvent(new Event('pointerenter', { relatedTarget: old, ...mouse, ...pointer }));
        n.dispatchEvent(new Event('mouseenter', { relatedTarget: old, ...mouse }));
      }
    }
    e.dispatchEvent(new Event('pointermove', { bubbles: true, cancelable: true, ...mouse, ...pointer }));
    e.dispatchEvent(new Event('mousemove', { bubbles: true, cancelable: true, ...mouse }));
  };

  const pressAt = (e, button, mouse) => {
    const buttons = button === 2 ? 2 : 1;
    document.activated = document.hooks.now();
    e.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true, buttons, ...mouse, ...pointer }));
    if (e.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true, buttons, ...mouse }))) {
      let f = e;
      while (f && f.nodeType === 1 && !focusable(f)) f = f.parentNode;
      if (f && f.nodeType === 1) f.focus();
      else document.moveFocus(null);
    }
  };

  const releaseAt = (e, mouse) => {
    e.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true, buttons: 0, ...mouse, ...pointer }));
    e.dispatchEvent(new Event('mouseup', { bubbles: true, cancelable: true, buttons: 0, ...mouse }));
  };

  const clicked = (e, at, detail) => {
    const mouse = { button: 0, detail, ...where(e, at) };
    pressAt(e, 0, mouse);
    releaseAt(e, mouse);
    document.clickOn(e, { buttons: 0, ...mouse });
  };

  return {
    click(e, at) {
      if (disabled(e)) return;
      moveTo(e, at);
      clicked(e, at, 1);
    },
    rightClick(e) {
      if (disabled(e)) return;
      moveTo(e, null);
      const mouse = { button: 2, detail: 1, ...where(e, null) };
      pressAt(e, 2, mouse);
      e.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true, buttons: 2, ...mouse }));
      releaseAt(e, mouse);
      e.dispatchEvent(new Event('auxclick', { bubbles: true, cancelable: true, buttons: 0, ...mouse, ...pointer }));
    },
    doubleClick(e) {
      if (disabled(e)) return;
      moveTo(e, null);
      clicked(e, null, 1);
      clicked(e, null, 2);
      e.dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true, button: 0, buttons: 0, detail: 2, ...where(e, null) }));
    },
    hover(e) {
      moveTo(e, null);
    },
    wheel(e, dx, dy) {
      moveTo(e, null);
      e.dispatchEvent(new Event('wheel', {
        bubbles: true, cancelable: true, deltaX: dx, deltaY: dy, deltaZ: 0, deltaMode: 0, button: 0, buttons: 0, ...where(e, null),
      }));
    },
    type(e, text) {
      if (document.activeElement !== e) e.focus();
      for (const c of text) press(c === '\n' ? 'Enter' : c, {});
    },
    press(spec) {
      const { key: name, held } = parseKey(spec);
      press(name, held);
    },
    moveMouse(dx, dy) {
      const e = document.pointerLockElement || document.body;
      const mouse = { button: 0, buttons: 0, movementX: dx, movementY: dy, view: window, ...down };
      e.dispatchEvent(new Event('pointermove', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...mouse }));
      e.dispatchEvent(new Event('mousemove', { bubbles: true, cancelable: true, ...mouse }));
    },
    keyDown(spec) {
      const { key: name, held } = parseKey(spec);
      if (modifiers[name]) down[modifiers[name]] = true;
      key(target(), 'keydown', name, held);
    },
    keyUp(spec) {
      const { key: name, held } = parseKey(spec);
      if (modifiers[name]) down[modifiers[name]] = false;
      key(target(), 'keyup', name, held);
    },
  };
}
