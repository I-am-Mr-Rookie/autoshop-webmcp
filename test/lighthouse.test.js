import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('homepage tool-contract notes stay outside definition lists', async () => {
  const home = await readFile(new URL('../public/home.html', import.meta.url), 'utf8');
  const lists = [...home.matchAll(/<dl>([\s\S]*?)<\/dl>/g)];

  assert.equal(lists.length, 2);
  for (const [, contents] of lists) assert.doesNotMatch(contents, /class="note"/);
  assert.equal((home.match(/<p class="note">/g) ?? []).length, 2);
});

test('buyer and seller portal navigation keeps the public repository visible', async () => {
  const portal = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(portal, /class="portal-nav"[^>]*>[\s\S]*href="https:\/\/github\.com\/I-am-Mr-Rookie\/autoshop-webmcp"/);
});
