import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { createAppServer } from '../server.js';

const read = name => readFile(new URL('../public/' + name, import.meta.url), 'utf8');

test('home loads exactly one external motion module and no inline script', async () => {
  const home = await read('home.html');
  const scripts = [...home.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.deepEqual(scripts.map(m => m[0]), ['<script type="module" src="/home-motion.js"></script>']);
  for (const other of ['index.html', 'privacy.html', 'terms.html']) assert.doesNotMatch(await read(other), /home-motion/);
});

test('without the motion module, home content is static and fully visible', async () => {
  const home = await read('home.html');
  assert.doesNotMatch(home, /class="[^"]*\brise\b/);
  assert.doesNotMatch(home, /@keyframes/);
  for (const [rule] of home.matchAll(/[^{}]*\{[^{}]*opacity:\s*0[;\s}][^{}]*\}/g)) {
    assert.match(rule.trim(), /^(\.motion|\.packet|\.ambient)/, 'opacity 0 only behind .motion: ' + rule.trim());
  }
});

test('motion module stays under 8 KB gzipped and has no imports', async () => {
  const source = await read('home-motion.js');
  const size = gzipSync(source, { level: 9 }).length;
  assert.ok(size <= 8192, 'gzip ' + size);
  assert.doesNotMatch(source, /^\s*import\b|import\(/m);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /visibilitychange/);
});

test('motion keyframes animate only transform and opacity', async () => {
  const motion = await import('../public/home-motion.js');
  const allowed = new Set(['transform', 'opacity', 'offset', 'easing']);
  const stops = [{ x: 0, y: 10 }, { x: 0, y: 60, human: true }, { x: 300, y: 10, jump: true }, { x: 300, y: 90, human: true }];
  const { dot, human } = motion.packetFrames(stops);
  for (const frames of [motion.riseFrames(), motion.ambientFrames(1), dot, human]) {
    assert.ok(frames.length >= 2);
    for (const frame of frames) for (const key of Object.keys(frame)) assert.ok(allowed.has(key), 'animated ' + key);
  }
  const offsets = dot.map(f => f.offset);
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1), 1);
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] >= offsets[i - 1], 'offsets ascend');
  assert.ok(dot.some(f => f.opacity === 0 && f.offset > 0 && f.offset < 1), 'packet hides while jumping between lists');
  assert.ok(human.some(f => f.opacity === 1), 'human stops turn the packet amber');
});

test('motion module is served as JavaScript under the unchanged CSP', async t => {
  const server = createAppServer({ healthcheck: async () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/home-motion.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'sha256-mTJ4cJaTm2Gw95GeXEpZdvEEY9ybh6FZu1bwcNE7QlY='; /);
});
