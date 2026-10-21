import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import * as auth from '../public/auth.js';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const html = await read('index.html');
const gate = html.match(/<section id="auth-gate"[\s\S]*?<\/section>/)[0];

// Minimal browser stand-in: enough DOM, location, and script loading for ensureSession to run end to end.
const fakeBrowser = (t, { pathname = '/buyer', config = { ok: true, domain: 'auth.example', publishableKey: 'pk_test_x' }, fetchError, clerk } = {}) => {
  const element = () => ({ hidden: false, disabled: true, textContent: '', title: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const nodes = Object.fromEntries(['#auth-gate', '#auth-status', '#google-sign-in', '#clerk-auth-component', '#demo-account', '#account-label', '#demo-sign-out'].map(id => [id, element()]));
  const events = [];
  const state = { reloads: 0, replaced: null, events, nodes };
  const saved = Object.fromEntries(['document', 'window', 'location', 'getComputedStyle', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  set('document', {
    querySelector: selector => nodes[selector],
    createElement: () => ({ dataset: {} }),
    head: { appendChild: script => setTimeout(() => script.onload()) },
    documentElement: {},
    body: { classList: { remove() {} } },
    dispatchEvent: event => events.push(event.type)
  });
  set('location', { pathname, origin: 'http://localhost:3107', reload: () => { state.reloads += 1; }, replace: url => { state.replaced = url; } });
  set('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  set('fetch', async () => { if (fetchError) throw fetchError; return { ok: true, json: async () => config }; });
  set('window', { Clerk: clerk, __internal_ClerkUICtor: function UI() {} });
  return state;
};

const fakeClerk = user => {
  const clerk = { user, session: user ? {} : null, listeners: [], signOuts: [], mounted: [],
    load: async () => {}, addListener: fn => clerk.listeners.push(fn), signOut: options => clerk.signOuts.push(options),
    mountSignIn: (node, options) => clerk.mounted.push(options), mountSignUp: (node, options) => clerk.mounted.push(options),
    client: { signIn: { authenticateWithRedirect: async options => { clerk.redirect = options; } } } };
  return clerk;
};

test('session helpers are provider-neutral and the app uses them', async () => {
  assert.equal(typeof auth.ensureSession, 'function');
  assert.equal(typeof auth.signOut, 'function');
  assert.equal(auth.ensureGoogleSession, undefined);
  assert.equal(auth.signOutGoogle, undefined);
  const app = await read('app.js');
  assert.match(app, /import \{[^}]*\bensureSession\b[^}]*\bsignOut\b[^}]*\} from '\.\/auth\.js'/);
  assert.doesNotMatch(app, /ensureGoogleSession|signOutGoogle/);
});

test('Google returns through /sso-callback to the portal that started it', () => {
  for (const [path, target] of [['/buyer', '/buyer'], ['/seller', '/seller'], ['/sign-in', '/seller'], ['/sign-up', '/seller']]) {
    assert.deepEqual(auth.googleRedirectOptions('https://shop.example', path), {
      strategy: 'oauth_google', redirectUrl: 'https://shop.example/sso-callback', redirectUrlComplete: `https://shop.example${target}`
    }, path);
  }
});

test('the account chip names the signed-in account without provider wording', () => {
  assert.equal(auth.accountLabel({ primaryEmailAddress: { emailAddress: 'a@example.com' }, fullName: 'A B' }), 'a@example.com');
  assert.equal(auth.accountLabel({ primaryEmailAddress: null, fullName: 'A B' }), 'A B');
  assert.equal(auth.accountLabel({}), 'your account');
});

test('signed-out gate offers Google or email with neutral copy, and Google redirects through /sso-callback', async t => {
  const clerk = fakeClerk(null);
  const state = fakeBrowser(t, { pathname: '/buyer', clerk });
  assert.equal(await auth.ensureSession(), false);
  const { '#auth-status': status, '#google-sign-in': button } = state.nodes;
  assert.match(status.textContent, /^Sign in with Google or your email\./);
  assert.equal(button.disabled, false);
  assert.equal(clerk.mounted.length, 1);
  await button.listeners.click();
  assert.equal(clerk.redirect.redirectUrl, 'http://localhost:3107/sso-callback');
  assert.equal(clerk.redirect.redirectUrlComplete, 'http://localhost:3107/buyer');
});

test('a sign-in load failure shows neutral copy, never a library or provider message', async t => {
  const state = fakeBrowser(t, { fetchError: new Error('ClerkJS: network failure') });
  assert.equal(await auth.ensureSession(), false);
  assert.equal(state.nodes['#auth-status'].textContent, 'Sign-in could not load. Refresh to retry.');
  assert.equal(state.nodes['#google-sign-in'].disabled, true);
});

test('the callback page finishes sign-in with neutral copy', async t => {
  const clerk = fakeClerk(null);
  clerk.handleRedirectCallback = async options => { clerk.callback = options; };
  const state = fakeBrowser(t, { pathname: '/sso-callback', clerk });
  assert.equal(await auth.ensureSession(), false);
  assert.equal(state.nodes['#auth-status'].textContent, 'Finishing sign-in…');
  assert.equal(clerk.callback.signInUrl, '/sign-in');
});

test('signed in: account chip shows the account, sign out works, and session loss reloads', async t => {
  const clerk = fakeClerk({ id: 'user_1', primaryEmailAddress: { emailAddress: 'a@example.com' } });
  const state = fakeBrowser(t, { pathname: '/seller', clerk });
  assert.equal(await auth.ensureSession(), true);
  const { '#auth-gate': gateNode, '#demo-account': chip, '#account-label': label, '#demo-sign-out': out } = state.nodes;
  assert.equal(gateNode.hidden, true);
  assert.equal(chip.hidden, false);
  assert.equal(label.textContent, 'a@example.com');
  await out.listeners.click();
  assert.deepEqual(clerk.signOuts, [{ redirectUrl: '/' }]);
  clerk.listeners[0]({ user: clerk.user, session: {} });
  assert.equal(state.reloads, 0, 'same account keeps the page');
  clerk.listeners[0]({ user: null, session: null });
  assert.deepEqual(state.events, ['autoshop:seller-session-lost']);
  assert.equal(state.reloads, 1);
});

test('Google button follows the light-theme sign-in button guidelines', () => {
  const button = gate.match(/<button id="google-sign-in"[\s\S]*?<\/button>/)[0];
  for (const color of ['#EA4335', '#4285F4', '#FBBC05', '#34A853']) assert.match(button, new RegExp(`fill="${color}"`), color);
  assert.match(button, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(button, /<span>Continue with Google<\/span>/);
  const rule = html.match(/#google-sign-in \{([^}]*)\}/)[1];
  assert.match(rule, /background: #fff(?:fff)?;/i);
  assert.match(rule, /border: 1px solid #747775;/i);
  assert.match(rule, /color: #1f1f1f;/i);
  assert.match(rule, /font: 500 14px\/20px "Google Sans", Roboto, Arial, sans-serif;/);
  assert.match(html, /#google-sign-in svg \{[^}]*width: 18px; height: 18px;/);
});

test('Google and email share one column width; sign out is a compact account-chip action', () => {
  const { elements } = auth.appearanceFromTokens(() => '');
  assert.equal(elements.rootBox.width, '100%');
  assert.equal(elements.cardBox.width, '100%');
  assert.match(gate, /<div class="auth-methods">\s*<button id="google-sign-in"[\s\S]*<div id="clerk-auth-component"/);
  const account = html.match(/<div id="demo-account"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.match(account, /<span id="account-label">/);
  assert.match(account, /<button id="demo-sign-out" class="btn-ghost" type="button">Sign out<\/button>/);
});

test('no user-visible "Clerk" or Google-only signed-in copy in public pages and scripts', async () => {
  assert.doesNotMatch(html, /signed in with Google/i);
  for (const name of await readdir(new URL('../public/', import.meta.url))) {
    const source = /\.(html|js)$/.test(name) ? await read(name) : '';
    if (name.endsWith('.html')) {
      const visible = source.replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]*?((?:aria-label|title|alt|placeholder)="[^"]*")?[^>]*>/g, ' $1 ');
      assert.doesNotMatch(visible, /clerk/i, name);
    } else if (name.endsWith('.js')) {
      // String literals only; identifiers, the script URL package names, and DOM ids are D7 devtools-level traces.
      const literals = source.match(/'[^'\n]*'|`[^`]*`/g) ?? [];
      const visible = literals.filter(text => !/@clerk\/|#clerk-auth-component|clerkPublishableKey/.test(text));
      assert.deepEqual(visible.filter(text => /clerk/i.test(text)), [], name);
    }
  }
});
