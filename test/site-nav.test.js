import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BUYER_TOOLS, SELLER_TOOLS, markCurrentNav, registerRoleTools } from '../public/app.js';
import { createAppServer } from '../server.js';

const page = async name => (await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const navOf = html => html.match(/<nav class="topbar"[\s\S]*?<\/nav>/)?.[0];
const pages = ['home.html', 'index.html', 'privacy.html', 'terms.html'];

test('every page shares one Home · Seller · Buyer · GitHub nav', async () => {
  const navs = await Promise.all(pages.map(async name => navOf(await page(name))));
  for (const [index, nav] of navs.entries()) assert.ok(nav, `${pages[index]} has the shared nav`);
  const labels = [...navs[0].matchAll(/<div class="portal-nav">[\s\S]*?<\/div>/g)][0][0]
    .match(/<a\b[^>]*>([^<]+)/g).map(link => link.replace(/<a\b[^>]*>/, ''));
  assert.deepEqual(labels, ['Home', 'Seller', 'Buyer', 'GitHub']);
  const plain = navs.map(nav => nav.replace(/ aria-current="page"/g, ''));
  for (const nav of plain.slice(1)) assert.equal(nav, plain[0]);
  assert.match(plain[0], /href="https:\/\/github\.com\/I-am-Mr-Rookie\/autoshop-webmcp" target="_blank" rel="noopener noreferrer"/);
});

test('Home is the only statically current nav item; portals mark their role at runtime', async () => {
  const [home, portal, privacy, terms] = await Promise.all(pages.map(async name => navOf(await page(name))));
  assert.deepEqual(home.match(/<a [^>]*aria-current="page"[^>]*>[^<]+/g), ['<a href="/" aria-current="page">Home']);
  for (const nav of [portal, privacy, terms]) assert.doesNotMatch(nav, /aria-current/);

  const marked = [];
  const doc = { querySelector: selector => ({ setAttribute: (name, value) => marked.push([selector, name, value]) }) };
  for (const path of ['/buyer', '/seller', '/', '/privacy', '/buyer/x']) markCurrentNav(doc, path);
  assert.deepEqual(marked, [
    ['.portal-nav a[href="/buyer"]', 'aria-current', 'page'],
    ['.portal-nav a[href="/seller"]', 'aria-current', 'page']
  ]);
});

test('architecture section matches the registered tools, shop schema, and lifecycle', async () => {
  const home = await page('home.html');
  const section = home.match(/<section[^>]*aria-labelledby="architecture-title"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, 'architecture section exists');
  assert.match(section, new RegExp(`${BUYER_TOOLS.length} buyer tools`));
  assert.match(section, new RegExp(`${SELLER_TOOLS.length} seller tools`));
  for (const { name } of [...BUYER_TOOLS, ...SELLER_TOOLS]) assert.match(section, new RegExp(`<code>${name}</code>`));
  assert.match(section, /shop_&lt;sha256/);
  assert.match(section, /Railway/);
  assert.match(section, /Postgres/);
  for (const step of ['Mandate', 'Pending', 'Approval', 'Receipt']) assert.match(section, new RegExp(`<strong>${step}</strong>`));
  assert.match(section, /<figcaption[^>]*id="architecture-text"/);
  assert.doesNotMatch(section, /clerk/i);

  for (const path of ['/', '/privacy', '/terms']) {
    const registered = [];
    await registerRoleTools({ registerTool: async tool => registered.push(tool.name) }, path, () => {});
    assert.deepEqual(registered, [], `${path} registers no WebMCP tools`);
  }
});

test('privacy and terms are script-free pages that link to each other', async () => {
  for (const [name, other, title] of [['privacy.html', '/terms', 'Privacy'], ['terms.html', '/privacy', 'Terms']]) {
    const html = await page(name);
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, new RegExp(`<title>${title}[^<]*AutoShop</title>`));
    assert.match(html, /<main[^>]*>[\s\S]*<h1/);
    assert.match(html, new RegExp(`href="${other}"`));
    assert.doesNotMatch(html, /clerk/i);
  }
});

test('privacy and terms are served with 200', async t => {
  const options = { healthcheck: async () => {} };
  const server = createAppServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  options.origin = base;
  for (const [path, heading] of [['/privacy', 'Privacy'], ['/terms', 'Terms']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), new RegExp(`<h1[^>]*>${heading}`));
  }
});
