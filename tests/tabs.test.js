'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');

test('the top bar has 9 tabs, each with its own view, and no Digests link', () => {
  const tabs = [...html.matchAll(/<button class="tab[^"]*" data-view="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ['learn', 'library', 'practice', 'reader', 'analyses', 'quiz', 'journal', 'news', 'settings']);
  tabs.forEach(name => assert.match(html, new RegExp(`<section class="view[^"]*" id="view-${name}">`)));
  assert.doesNotMatch(html, /href="digests\//);
  ['view-add', 'view-drill', 'view-reading', 'view-stats'].forEach(id => assert.ok(!html.includes(`id="${id}"`), id));
});

test('what the old tabs held is now inside the new ones', () => {
  const section = name => html.slice(html.indexOf(`id="view-${name}"`), html.indexOf('</section>', html.indexOf(`id="view-${name}"`)));
  ['newWord', 'bulkInput', 'saveWordBtn', 'libraryList'].forEach(id => assert.ok(section('library').includes(`id="${id}"`), id));
  ['readingPassage', 'readingPlayAll', 'drillStartBtn', 'drillDisplay'].forEach(id => assert.ok(section('practice').includes(`id="${id}"`), id));
  ['statTotal', 'heatmap', 'levelChart', 'flashcard'].forEach(id => assert.ok(section('learn').includes(`id="${id}"`), id));
});

// showView from app.js with a fake page
function routing() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, { id, open: false, classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
        scrollIntoView() { this.scrolled = true; }, focus() { this.focused = true; } });
    }
    return elements.get(id);
  };
  const views = ['learn', 'library', 'practice', 'settings'].map(name => element(`view-${name}`));
  const rendered = [];
  const context = vm.createContext({
    state: { words: [{ id: 'w1', text: 'walk' }] },
    document: { getElementById: element, querySelectorAll: selector => (selector === '.view' ? views : []), querySelector: () => null },
    startSession: () => rendered.push('session'), renderStats: () => rendered.push('stats'),
    renderLibrary: () => rendered.push('library'), renderReading: () => rendered.push('reading'),
  });
  vm.runInContext(app.slice(app.indexOf('// ============ View routing'), app.indexOf('// ============ TTS')), context);
  const active = () => views.filter(v => v.classList.set.has('active')).map(v => v.id);
  return { run: code => vm.runInContext(code, context), element, rendered, active };
}

test('old view names open the tab that now holds them', () => {
  const r = routing();
  r.run("showView('stats')");
  assert.deepEqual(r.active(), ['view-learn']);
  assert.ok(r.rendered.includes('stats') && r.rendered.includes('session'), 'Learn shows progress and starts a session');
  r.run("showView('drill')");
  assert.deepEqual(r.active(), ['view-practice']);
  r.run("showView('reading')");
  assert.deepEqual(r.active(), ['view-practice']);
  assert.equal(r.element('addWordPanel').open, false);
  r.run("showView('add')");
  assert.deepEqual(r.active(), ['view-library']);
  assert.equal(r.element('addWordPanel').open, true, 'Add word opens the form inside Words');
  assert.equal(r.element('newWord').focused, true);
});

test('Words opens the add form by itself when the library is still empty', () => {
  const r = routing();
  r.run("state.words = []; showView('library')");
  assert.equal(r.element('addWordPanel').open, true);
  assert.notEqual(r.element('newWord').focused, true, 'No jump or keyboard pop-up when just opening the tab');
});
