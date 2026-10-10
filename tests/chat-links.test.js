'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 };
const IPAD_DESKTOP_MODE = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 };
const MAC = { userAgent: IPAD_DESKTOP_MODE.userAgent, platform: 'MacIntel', maxTouchPoints: 0 };
const ANDROID = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 };

function link(chat) {
  const attributes = new Map([['target', '_blank']]);
  return {
    dataset: { chat }, href: '', rel: '',
    get target() { return attributes.get('target') || ''; },
    set target(value) { attributes.set('target', value); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

function load(navigator) {
  const links = [link('claude'), link('chatgpt')];
  const calls = { copied: [], toasts: [] };
  const sandbox = vm.createContext({
    navigator: { ...navigator, clipboard: { writeText: async text => { calls.copied.push(text); } } },
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll: selector => (selector === 'a[data-chat]' ? links : []) },
    toast: message => calls.toasts.push(message), console,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../chat-links.js'), 'utf8'), sandbox);
  return { sandbox, links, calls, run: code => vm.runInContext(code, sandbox) };
}

test('iPhone and iPad (including desktop mode) are recognised; Macs and Android are not', () => {
  assert.equal(load(IPHONE).run('isAppleMobile()'), true);
  assert.equal(load(IPAD_DESKTOP_MODE).run('isAppleMobile()'), true);
  assert.equal(load(MAC).run('isAppleMobile()'), false);
  assert.equal(load(ANDROID).run('isAppleMobile()'), false);
});

test('on iPhone the ChatGPT button is a same-tab link the ChatGPT app opens', () => {
  const h = load(IPHONE);
  h.run('setupChatLinks()');
  const [claude, chatgpt] = h.links;
  assert.equal(chatgpt.href, 'https://chatgpt.com/#native', 'The address the ChatGPT app claims for a new chat');
  assert.equal(chatgpt.target, '', 'iOS only hands a link to an app when it opens in the same tab from a tap');
  assert.equal(claude.href, 'https://claude.ai/new');
});

test('on a computer the links open the websites in a new tab', () => {
  const h = load(MAC);
  h.run('setupChatLinks()');
  const [claude, chatgpt] = h.links;
  assert.equal(chatgpt.href, 'https://chatgpt.com/');
  assert.equal(chatgpt.target, '_blank');
  assert.equal(chatgpt.rel, 'noopener');
  assert.equal(claude.href, 'https://claude.ai/new');
});

test('the prompt is copied with a message naming the chat', async () => {
  const h = load(IPHONE);
  await h.run(`copyChatPrompt('chatgpt', 'Explain this passage')`);
  assert.deepEqual(h.calls.copied, ['Explain this passage']);
  assert.match(h.calls.toasts.at(-1), /ChatGPT/);
});

test('links made later (such as the role-play button in an analysis) get the same address and tab rules', () => {
  assert.equal(load(IPHONE).run('chatLinkAttributes("chatgpt")'), 'href="https://chatgpt.com/#native"');
  assert.equal(load(MAC).run('chatLinkAttributes("chatgpt")'), 'href="https://chatgpt.com/" target="_blank" rel="noopener"');
  assert.equal(load(IPHONE).run('chatLinkAttributes("claude")'), 'href="https://claude.ai/new"');
});
