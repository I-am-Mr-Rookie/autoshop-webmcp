import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

// Rebrand Run 11a: glyphs outside the self-hosted latin subsets forced a system font
// fallback lookup on first layout (the residual Home long task). A tiny Source Code Pro
// symbols face, first in every stack and limited by unicode-range, covers them.
const publicDir = new URL('../public/', import.meta.url);
const read = name => readFile(new URL(name, publicDir), 'utf8');

const ranges = body => {
  const value = body.match(/unicode-range:\s*([^;]+);/)[1];
  return value.split(',').map(part => {
    const [lo, hi] = part.trim().replace(/^U\+/i, '').split('-');
    return [parseInt(lo, 16), parseInt(hi ?? lo, 16)];
  });
};
const faces = css => [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => body);
const covered = (cp, list) => list.some(([lo, hi]) => cp >= lo && cp <= hi);

test('symbols face is a tiny unicode-range face first in every font stack', async () => {
  const css = await read('site.css');
  const face = faces(css).find(body => body.includes('font-family: "AutoShop Symbols";'));
  assert.ok(face, 'AutoShop Symbols @font-face exists');
  assert.match(face, /src: url\(\/fonts\/source-code-pro-symbols-wght-normal\.woff2\) format\("woff2"\);/);
  assert.match(face, /font-weight: 200 900;/);
  assert.deepEqual(ranges(face), [[0x2192, 0x2192], [0x2197, 0x2197], [0x25cf, 0x25cf]]);
  const { size } = await stat(new URL('fonts/source-code-pro-symbols-wght-normal.woff2', publicDir));
  assert.ok(size > 0 && size <= 4096, 'symbols subset stays under 4 KB, got ' + size);
  for (const token of ['--serif', '--sans', '--mono']) {
    assert.match(css, new RegExp(token + ': "AutoShop Symbols", '), token + ' starts with the symbols face');
  }
});

test('every non-ASCII glyph Home and the shared stylesheet render is in a self-hosted range', async () => {
  const css = await read('site.css');
  const covering = faces(css).filter(body => /url\(/.test(body)).flatMap(ranges);
  for (const name of ['home.html', 'site.css']) {
    const text = (await read(name)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    const missing = [...new Set([...text].filter(ch => ch.codePointAt(0) > 0x7f && !covered(ch.codePointAt(0), covering)))];
    assert.deepEqual(missing, [], name + ' has glyphs that fall back to system fonts');
  }
});

// Rebrand Run 11f: unpreloaded, the symbols face is still pending at the first layout, so
// → ↗ ● walk every fallback stack (one system typeface per size/weight, Segoe UI Symbol via
// character fallback) and its later arrival relayouts all text. Preloaded beside the latin
// faces it is ready at the first layout on every page that renders the shared nav.
const symbolsPreload = '<link rel="preload" href="/fonts/source-code-pro-symbols-wght-normal.woff2" as="font" type="font/woff2" crossorigin>';

test('every page that preloads the latin faces also preloads the symbols face', async () => {
  for (const name of ['home.html', 'index.html', 'privacy.html', 'terms.html']) {
    const html = await read(name);
    assert.match(html, /rel="preload" href="\/fonts\/source-code-pro-latin-wght-normal\.woff2"/, name + ' preloads the latin mono face');
    assert.ok(html.includes(symbolsPreload), name + ' preloads the symbols face as a CORS font');
    assert.equal(html.match(/rel="preload"[^>]*symbols/g).length, 1, name + ' preloads the symbols face once');
    assert.ok(html.indexOf(symbolsPreload) < html.indexOf('<link rel="stylesheet"'), name + ' preloads before the stylesheet');
  }
});
