import { Readable } from 'node:stream';

const NO_BODY = new Set([101, 204, 205, 304]);

// Runs the Node request listener from server.js for one Web Request, so Netlify serves the
// same routing, headers, auth, and static files as the long-running Railway process.
export const handleWithNodeServer = (server, request) => new Promise((resolve, reject) => {
  const listener = server.listeners('request')[0];
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  // The platform-observed URL is authoritative; never trust client-sent forwarding headers.
  headers.host = url.host;
  headers['x-forwarded-host'] = url.host;
  headers['x-forwarded-proto'] = url.protocol.slice(0, -1);
  const req = Readable.from(request.body ?? []);
  Object.assign(req, { method: request.method, url: url.pathname + url.search, headers });

  let status = 200;
  let sent = false;
  const out = new Headers();
  const res = {
    get headersSent() { return sent; },
    setHeader(name, value) {
      out.delete(name);
      for (const item of [].concat(value)) out.append(name, String(item));
    },
    writeHead(code, values = {}) {
      status = code;
      for (const [name, value] of Object.entries(values)) res.setHeader(name, value);
      sent = true;
      return res;
    },
    end(body) {
      sent = true;
      resolve(new Response(NO_BODY.has(status) || body == null ? null : body, { status, headers: out }));
    },
    destroy(error) { reject(error ?? new Error('Response stream destroyed.')); }
  };
  Promise.resolve(listener(req, res)).catch(reject);
});
