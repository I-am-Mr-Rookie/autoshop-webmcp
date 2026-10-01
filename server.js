import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from './database.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8' };

export const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'sha256-mTJ4cJaTm2Gw95GeXEpZdvEEY9ybh6FZu1bwcNE7QlY='; style-src 'self' 'unsafe-inline'",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

const modules = await Promise.all([
  'buyer', 'buyer-confirm', 'buyer-order', 'seller-auth', 'seller-orders',
  'seller-mandate', 'seller-accept', 'seller-approval', 'seller-commit', 'demo-data'
].map(name => import(`./functions/${name}.mjs`)));
const routes = new Map(modules.map(module => [module.config.path, module]));

export const createAppServer = (options = {}) => createServer(async (req, res) => {
  for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
  const send = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: { code: status === 503 ? 'UNAVAILABLE' : 'VALIDATION', message } }));
  };
  try {
    const origin = options.origin ?? process.env.APP_ORIGIN
      ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`);
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return send(400, 'Invalid request URL.');
    const url = new URL(req.url, origin);
    if (url.origin !== new URL(origin).origin) return send(400, 'Invalid request origin.');
    if (url.pathname === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
      await (options.healthcheck ?? (() => getDatabase().pool.query('SELECT 1')))();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
    }
    const route = (options.routes ?? routes).get(url.pathname);
    if (route) {
      res.setHeader('Cache-Control', 'no-store');
      if (!route.config.method.includes(req.method)) {
        res.setHeader('Allow', route.config.method.join(', '));
        return send(405, 'Unsupported request method.');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return send(413, 'Request body is too large.');
        chunks.push(chunk);
      }
      const request = new Request(url, {
        method: req.method, headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
      });
      const response = await route.default(request);
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie') res.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.writeHead(response.status);
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    if (url.pathname.startsWith('/api/')) return send(404, 'API route not found.');
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Unsupported request method.');
    const path = decodeURIComponent(url.pathname);
    const file = path === '/' ? 'home.html' : ['/buyer', '/seller'].includes(path) ? 'index.html' : path.replace(/^\/+/, '');
    const fullPath = resolve(root, file);
    if (!fullPath.startsWith(root.endsWith(sep) ? root : root + sep) || path.includes('\0') || path === '/_redirects') return send(404, 'File not found.');
    try {
      const body = await readFile(fullPath);
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return send(404, 'File not found.');
      throw error;
    }
  } catch (error) {
    console.error('HTTP request failed');
    if (!res.headersSent) send(error instanceof URIError || error instanceof TypeError ? 400 : 503, 'Request could not be completed.');
    else res.destroy();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log('AutoShop server listening'));
  process.on('SIGTERM', () => {
    server.close(async () => { await getDatabase().pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
