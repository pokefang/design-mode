import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  createHandler, newToken, configScript, defaultQueueDir, isLocalHostName, SELECTION_ROUTE, OVERLAY_ROUTE,
} from './server.js';

const ROUTE_PREFIX = '/__design-mode/';
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const LOCAL_ALIASES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Accepts "localhost:3000" or "http://localhost:3000/"; returns a URL for the app origin. */
export const parseAppOrigin = (value) => {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('--proxy needs the app origin, for example --proxy http://localhost:3000');
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`--proxy must be an http or https origin, got ${u.protocol}`);
  return u;
};

/** The two script tags every proxied HTML page gets: this boot's config, then the overlay. */
export const bootSnippet = (token) => {
  const cfg = configScript({ endpoint: SELECTION_ROUTE, token }).replace(/</g, '\\u003c');
  // defer: the overlay runs after the document is parsed, so <body> exists when it boots
  return `<script>${cfg}</script><script defer src="${OVERLAY_ROUTE}"></script>`;
};

/** Insert the snippet before </head>, else before the last </body>, else at the end. */
export const injectSnippet = (html, snippet) => {
  const head = /<\/head\s*>/i.exec(html);
  if (head) return html.slice(0, head.index) + snippet + html.slice(head.index);
  let body = -1;
  const re = /<\/body\s*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) body = m.index;
  if (body !== -1) return html.slice(0, body) + snippet + html.slice(body);
  return html + snippet;
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const badGateway = (origin, why) => `<!doctype html><meta charset="utf-8"><title>Design Mode: app not running</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:12vh auto;padding:0 20px">
<h1 style="font-size:20px">The app at ${esc(origin)} is not running</h1>
<p>Design Mode is waiting for it. Start the app, then reload this page.</p>
<p style="opacity:.6;font-size:13px">${esc(why)}</p></body>`;

/**
 * Proxy mode: Design Mode sits in front of the app. The user opens the PROXY url;
 * every request is forwarded to the app, and HTML responses get the overlay injected,
 * so Design Mode is present on every page load and navigation with nothing to paste.
 *
 * Security is unchanged: the overlay is same-origin with the proxy, so it talks to the
 * relative /__design-mode/selection route, and createHandler still enforces the token
 * header, the Origin check and the local-Host check. The token is only written into HTML
 * when the request's Host header is a local name, so a DNS-rebinding page gets the app's
 * HTML without a token.
 */
export function serveProxy({ proxy, port = 3850, queueDir, root = process.cwd(), log = console.log } = {}) {
  const target = proxy instanceof URL ? proxy : parseAppOrigin(proxy);
  const transport = target.protocol === 'https:' ? https : http;
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const token = newToken();
  const dir = queueDir ? path.resolve(root, queueDir) : defaultQueueDir(root);
  const allowOrigins = []; // filled once the port is known (port 0 picks a free one)
  const handle = createHandler({ token, queueDir: dir, root, allowOrigins, log });
  let selfPort = port;

  const proxyOrigin = (req) => `http://${req.headers.host || `localhost:${selfPort}`}`;
  // an app that redirects to http://localhost:3000 while we were pointed at 127.0.0.1:3000 is still the app
  const isTargetUrl = (u) => u.protocol === target.protocol
    && (Number(u.port) || (u.protocol === 'https:' ? 443 : 80)) === targetPort
    && (u.hostname === target.hostname || (LOCAL_ALIASES.has(u.hostname) && LOCAL_ALIASES.has(target.hostname)));
  const rewriteLocation = (value, req) => {
    try {
      const u = new URL(value);
      if (!isTargetUrl(u)) return value;
      return proxyOrigin(req) + u.pathname + u.search + u.hash;
    } catch { return value; } // relative: already points at whoever asked
  };
  // the app sees requests as if they came straight from its own origin
  const rewriteRequestOrigin = (value, req) => {
    const self = proxyOrigin(req);
    return value === self ? target.origin : value.startsWith(`${self}/`) ? target.origin + value.slice(self.length) : value;
  };

  const upstreamHeaders = (req, forHtml) => {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k)) continue;
      out[k] = v;
    }
    out.host = target.host;
    if (out.origin) out.origin = rewriteRequestOrigin(out.origin, req);
    if (out.referer) out.referer = rewriteRequestOrigin(out.referer, req);
    out['accept-encoding'] = 'identity'; // so HTML can be rewritten without decoding
    if (forHtml) { delete out['if-none-match']; delete out['if-modified-since']; } // a 304 would resurrect an old token
    return out;
  };

  const sendBadGateway = (res, why) => {
    if (res.headersSent) { res.destroy(); return; }
    res.statusCode = 502;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(badGateway(target.origin, why));
  };

  const forward = (req, res) => {
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    const up = transport.request({
      protocol: target.protocol, hostname: target.hostname.replace(/^\[(.*)\]$/, '$1'), port: targetPort,
      method: req.method, path: req.url, headers: upstreamHeaders(req, wantsHtml), agent: false,
    }, (pr) => {
      const headers = {};
      for (const [k, v] of Object.entries(pr.headers)) {
        if (HOP.has(k)) continue;
        headers[k] = k === 'location' ? rewriteLocation(v, req) : v;
      }
      const status = pr.statusCode || 502;
      const isHtml = /^text\/html\b/i.test(String(pr.headers['content-type'] || ''));
      const bodiless = req.method === 'HEAD' || status === 204 || status === 304;
      const encoding = String(pr.headers['content-encoding'] || 'identity').toLowerCase();
      const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
        : encoding === 'deflate' ? zlib.createInflate()
        : encoding === 'br' ? zlib.createBrotliDecompress() : null;
      const canRewrite = isHtml && !bodiless && (encoding === 'identity' || decoder);

      if (!canRewrite) { // everything else streams through untouched
        res.writeHead(status, pr.statusMessage, headers);
        pr.pipe(res);
        pr.on('error', () => res.destroy());
        return;
      }
      // HTML: buffer, inject, resend. Length, encoding and validators describe the old bytes.
      delete headers['content-length'];
      delete headers['content-encoding'];
      delete headers.etag;
      delete headers['last-modified'];
      headers['cache-control'] = 'no-store';
      const src = decoder ? pr.pipe(decoder) : pr;
      const chunks = [];
      src.on('data', (c) => chunks.push(c));
      src.on('error', () => sendBadGateway(res, 'The app sent a response that could not be read.'));
      pr.on('error', () => sendBadGateway(res, 'The connection to the app dropped.'));
      src.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        if (isLocalHostName(req.headers.host)) html = injectSnippet(html, bootSnippet(token));
        const body = Buffer.from(html, 'utf8');
        headers['content-length'] = String(body.length);
        res.writeHead(status, pr.statusMessage, headers);
        res.end(body);
      });
    });
    up.on('error', (err) => sendBadGateway(res, err.code ? `${err.code}` : String(err.message || err)));
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    req.pipe(up);
  };

  const server = http.createServer((req, res) => {
    if (handle(req, res)) return;
    if ((req.url || '').startsWith(ROUTE_PREFIX)) { res.statusCode = 404; res.end('not found'); return; }
    forward(req, res);
  });

  // WebSocket (and any other Upgrade): HMR sockets for Vite, Astro and Next dev servers.
  // Raw bytes are piped both ways after the handshake is replayed to the app.
  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').startsWith(ROUTE_PREFIX)) { socket.destroy(); return; }
    const up = (target.protocol === 'https:' ? tls : net).connect({
      host: target.hostname.replace(/^\[(.*)\]$/, '$1'), port: targetPort, servername: target.hostname,
    });
    const kill = () => { socket.destroy(); up.destroy(); };
    up.on('error', kill);
    socket.on('error', kill);
    up.on('close', () => socket.destroy()); // either side going away tears down the other
    socket.on('close', () => up.destroy());
    up.on(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        let v = req.rawHeaders[i + 1];
        const lk = k.toLowerCase();
        if (lk === 'host') v = target.host;
        else if (lk === 'origin' || lk === 'referer') v = rewriteRequestOrigin(v, req);
        raw += `${k}: ${v}\r\n`;
      }
      up.write(`${raw}\r\n`);
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') { log(`[design-mode] port ${port} is already in use; pick another with --port`); process.exitCode = 1; return; }
    throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    selfPort = server.address().port;
    allowOrigins.push(`http://localhost:${selfPort}`, `http://127.0.0.1:${selfPort}`);
    log(`[design-mode] proxying http://localhost:${selfPort} -> ${target.origin}`);
    log(`[design-mode] open http://localhost:${selfPort} (not ${target.origin}) to use Design Mode`);
    log(`[design-mode] queue: ${path.relative(root, dir) || '.'}`);
  });
  return server;
}
