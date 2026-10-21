import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { appearanceFromTokens, emailSignInOptions, mountEmailSignIn } from '../public/auth.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('email sign-in returns each portal to itself and opts into sign-in-or-up', () => {
  for (const [path, target] of [['/buyer', '/buyer'], ['/seller', '/seller'], ['/sign-in', '/seller'], ['/sign-up', '/seller']]) {
    const options = emailSignInOptions(path);
    assert.equal(options.withSignUp, true, path);
    assert.equal(options.routing, 'hash', path);
    assert.equal(options.forceRedirectUrl, target, path);
    assert.equal(options.signUpForceRedirectUrl, target, path);
  }
});

test('email sign-in mounts the prebuilt sign-in or sign-up into the gate', () => {
  const calls = [];
  const clerk = { mountSignIn: (node, options) => calls.push(['in', node, options]), mountSignUp: (node, options) => calls.push(['up', node, options]) };
  const node = {};
  mountEmailSignIn(clerk, node, '/buyer');
  mountEmailSignIn(clerk, node, '/sign-up');
  assert.deepEqual(calls.map(([kind, target, options]) => [kind, target === node, options.forceRedirectUrl]), [['in', true, '/buyer'], ['up', true, '/seller']]);
});

test('prebuilt sign-in is themed from the live page brand tokens and leaves Google to the page button', () => {
  const tokens = { '--agent': ' #047857', '--ink': '#13241f', '--muted': '#52635c', '--alert': '#b42318', '--surface': '#ffffff', '--line-strong': '#a6b7af', '--radius': '3px', '--sans': 'Brand Sans, sans-serif' };
  const { variables, elements } = appearanceFromTokens(name => tokens[name] ?? '');
  assert.equal(variables.colorPrimary, '#047857');
  assert.equal(variables.colorForeground, '#13241f');
  assert.equal(variables.colorInputForeground, '#13241f');
  assert.equal(variables.colorMutedForeground, '#52635c');
  assert.equal(variables.colorDanger, '#b42318');
  assert.equal(variables.colorBackground, '#ffffff');
  assert.equal(variables.colorBorder, '#a6b7af');
  assert.equal(variables.borderRadius, '3px');
  assert.equal(variables.fontFamily, 'Brand Sans, sans-serif');
  assert.equal(elements.socialButtonsRoot.display, 'none');
  assert.equal(elements.dividerRow.display, 'none');
});

test('a missing brand token leaves that variable to the sign-in default', () => {
  const { variables } = appearanceFromTokens(() => '');
  assert.deepEqual(variables, {});
});

test('the sign-in client loads themed from the document tokens with telemetry off', async () => {
  const source = await readFile(new URL('../public/auth.js', import.meta.url), 'utf8');
  assert.match(source, /clerk\.load\(\{[^\n]*\bappearance: appearanceFromTokens\(name => getComputedStyle\(document\.documentElement\)\.getPropertyValue\(name\)\)[^\n]*\btelemetry: false[^\n]*\}\);/);
});

test('portal gates offer Google and an email code, with no password field anywhere', async () => {
  const gate = html.match(/<section id="auth-gate"[\s\S]*?<\/section>/)[0];
  assert.match(gate, /<h1 id="auth-title">Sign in to AutoShop<\/h1>/);
  assert.match(gate, /id="google-sign-in"/);
  assert.match(gate, /<div id="clerk-auth-component" role="group" aria-label="Sign in with an email code"><\/div>/);
  assert.ok(gate.indexOf('google-sign-in') < gate.indexOf('clerk-auth-component'), 'Google first, then email, in focus order');
  for (const name of await readdir(new URL('../public/', import.meta.url))) {
    if (!/\.(html|js)$/.test(name)) continue;
    const text = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /<input[^>]*type=["']?password|\.type\s*=\s*["']password|autocomplete=["']?(?:current|new)-password/i, name);
  }
});
