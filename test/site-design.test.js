import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createAppServer } from '../server.js';

const publicDir = new URL('../public/', import.meta.url);
const read = name => readFile(new URL(name, publicDir), 'utf8');
const pages = ['home.html', 'index.html', 'privacy.html', 'terms.html'];

const start = async t => {
  const server = createAppServer({ healthcheck: async () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const fontUrls = css => [...css.matchAll(/url\(([^)]+)\)/g)].map(([, url]) => url.replace(/["']/g, ''));

test('self-hosted fonts are served as font/woff2 under a font-src self CSP', async t => {
  const base = await start(t);
  const urls = fontUrls(await read('site.css'));
  assert.ok(urls.length >= 2, 'site.css declares self-hosted font files');
  for (const url of urls) {
    assert.match(url, /^\/fonts\/[\w.-]+\.woff2$/);
    const response = await fetch(base + url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('content-type'), 'font/woff2');
    assert.match(response.headers.get('content-security-policy'), /(^|; )font-src 'self'(;|$)/);
  }
});

test('every page shares one token stylesheet and loads no external fonts', async () => {
  for (const name of pages) {
    const html = await read(name);
    assert.match(html, /<link rel="stylesheet" href="\/site\.css">/, name);
    assert.doesNotMatch(html, /--canvas:|@font-face|fonts\.(googleapis|gstatic)|@import/, name);
    assert.doesNotMatch(html, /background-size:\s*32px 32px/, name + ' keeps no 32px grid');
  }
  const css = await read('site.css');
  assert.doesNotMatch(css, /https?:|@import|background-size:\s*32px 32px/);
});

test('type tokens use Source Serif 4 and Source Code Pro with metric-matched fallbacks', async () => {
  const css = await read('site.css');
  // Run 11a: an optional unicode-range "AutoShop Symbols" face may precede the text face (→ ↗ ● only).
  assert.match(css, /--mono:\s*(?:"AutoShop Symbols", )?"Source Code Pro", "Source Code Pro Fallback"/);
  assert.match(css, /--serif:\s*(?:"AutoShop Symbols", )?"Source Serif 4", "Source Serif 4 Fallback"/);
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => body);
  for (const family of ['Source Serif 4', 'Source Code Pro']) {
    const web = faces.find(body => body.includes('font-family: "' + family + '";'));
    assert.ok(web, family);
    assert.match(web, /font-display: swap/);
    const fallback = faces.find(body => body.includes('font-family: "' + family + ' Fallback";'));
    assert.ok(fallback, family + ' fallback');
    for (const descriptor of ['src: local(', 'size-adjust:', 'ascent-override:', 'descent-override:', 'line-gap-override:']) assert.ok(fallback.includes(descriptor), family + ' fallback ' + descriptor);
  }
});

test('each shipped font has its SIL OFL licence committed beside it', async () => {
  const fonts = (await readdir(new URL('fonts/', publicDir))).filter(file => file.endsWith('.woff2'));
  assert.ok(fonts.length >= 2);
  for (const font of fonts) {
    const family = font.startsWith('source-serif-4') ? 'SourceSerif4' : font.startsWith('source-code-pro') ? 'SourceCodePro' : null;
    assert.ok(family, 'unexpected font ' + font);
    const licence = await read('fonts/' + family + '-OFL.txt');
    assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/i);
    assert.match(licence, /Adobe/);
  }
});

test('home buyer copy reflects that sign-in is required', async () => {
  const home = await read('home.html');
  assert.doesNotMatch(home, /No account needed/i);
  assert.doesNotMatch(home, /Clerk/);
});

