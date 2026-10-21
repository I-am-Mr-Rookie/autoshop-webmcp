import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL('../public/' + name, import.meta.url), 'utf8');

test('every page has a keyboard skip target and matching theme color', async () => {
  for (const name of ['home.html', 'index.html', 'privacy.html', 'terms.html']) {
    const html = await read(name);
    assert.match(html, /<a class="skip-link" href="#main-content">Skip to content<\/a>/, name);
    assert.match(html, /id="main-content" tabindex="-1"/, name);
    assert.match(html, /<meta name="theme-color" content="#f2f5f3">/, name);
  }
  assert.match(await read('site.css'), /\.skip-link:focus/);
});

test('home offers a hidden-until-enhanced motion pause control and lazy below-fold images', async () => {
  const html = await read('home.html');
  assert.match(html, /id="motion-toggle"[^>]*aria-pressed="false"[^>]*hidden>Pause motion<\/button>/);
  for (const [image] of html.matchAll(/<img[^>]*src="\/img\/part-[^>]*>/g)) assert.match(image, /loading="lazy"/);
  const js = await read('home-motion.js');
  assert.match(js, /!paused && !hidden && gate\.visible/);
  assert.match(js, /paused = !paused/);
  assert.match(js, /setAttribute\('aria-pressed', String\(paused\)\)/);
});

test('seller and search inputs disable irrelevant autofill', async () => {
  const html = await read('index.html');
  for (const name of ['max_items_per_order', 'max_total_dollars', 'max_discount_percent', 'min_stock_remaining', 'action_id', 'query']) {
    const input = html.match(new RegExp('<input name="' + name + '"[^>]*>'))?.[0];
    assert.match(input ?? '', /autocomplete="off"/, name);
  }
});
