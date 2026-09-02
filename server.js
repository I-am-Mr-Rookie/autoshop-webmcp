import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') {
    res.writeHead(302, { Location: '/buyer' });
    res.end();
    return;
  }
  const file = ['/buyer', '/seller'].includes(path) ? 'index.html' : path.replace(/^\/+/, '');
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {
  console.log(`AutoShop listening on http://localhost:${process.env.PORT || 3000}`);
});
