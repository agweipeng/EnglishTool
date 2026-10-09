'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

// Minimal event targets: listeners by type, and a fixed on-screen box for the dialog
function target(extra = {}) {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, event) { (listeners[type] || []).forEach(fn => fn(event)); },
    ...extra,
  };
}

function load() {
  const doc = target();
  const sandbox = vm.createContext({ document: doc });
  vm.runInContext(fs.readFileSync(require.resolve('../outside-click.js'), 'utf8'), sandbox);
  return { sandbox, doc };
}

const box = { left: 100, right: 500, top: 100, bottom: 400 };

test('a modal window closes when you click the dimmed area around it', () => {
  const { sandbox } = load();
  const dialog = target({ getBoundingClientRect: () => box });
  let closed = 0;
  sandbox.closeOnBackdropClick(dialog, () => { closed++; });
  const outside = { target: dialog, clientX: 20, clientY: 20 };
  dialog.fire('pointerdown', outside);
  dialog.fire('click', outside);
  assert.equal(closed, 1);
});

test('clicks inside the window, and drags that start inside, keep it open', () => {
  const { sandbox } = load();
  const dialog = target({ getBoundingClientRect: () => box });
  const text = {};
  let closed = 0;
  sandbox.closeOnBackdropClick(dialog, () => { closed++; });
  // Padding of the window itself: the target is the dialog but the point is inside its box
  dialog.fire('pointerdown', { target: dialog, clientX: 110, clientY: 110 });
  dialog.fire('click', { target: dialog, clientX: 110, clientY: 110 });
  // Selecting text inside and letting go outside
  dialog.fire('pointerdown', { target: text, clientX: 200, clientY: 200 });
  dialog.fire('click', { target: dialog, clientX: 20, clientY: 20 });
  // A keyboard "click" on a button has no pointer position
  dialog.fire('click', { target: text, clientX: 0, clientY: 0 });
  assert.equal(closed, 0);
});

test('the word card closes on a tap or click elsewhere, but not on itself, on another word, or while selecting', () => {
  const { sandbox, doc } = load();
  const inside = {};
  const panel = target({ hidden: false, classList: { contains: name => name === 'hidden' && panel.hidden }, contains: node => node === inside });
  let closed = 0;
  let selecting = false;
  sandbox.closeOnClickAway(panel, () => { closed++; }, event => event.target.isWord || selecting);
  // Pointer events, because iPhone Safari doesn't send clicks on plain text to the document
  const tap = (down, up = down) => { doc.fire('pointerdown', { target: down }); doc.fire('pointerup', { target: up }); };
  tap(inside);
  tap({ isWord: true });
  tap(inside, {});   // selecting the card's sentence and letting go outside it
  selecting = true;
  tap({});
  selecting = false;
  doc.fire('pointerdown', { target: {} });
  doc.fire('pointercancel', {});   // the page scrolled instead
  doc.fire('pointerup', { target: {} });
  assert.equal(closed, 0);
  tap({});
  assert.equal(closed, 1);
  panel.hidden = true;
  tap({});
  assert.equal(closed, 1, 'A hidden card is left alone');
});
