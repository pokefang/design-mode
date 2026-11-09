import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { serveProxy, injectSnippet, parseAppOrigin } from '../src/proxy.mjs';
import { SELECTION_ROUTE, HEALTH_ROUTE } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-proxy-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 253, 254, 255, 0x0d, 0x0a]);
const PAGE = '<!doctype html><html><head><title>t</title></head><body><h1>hi</h1></body></html>';

let app; let appPort; let proxy; let proxyPort; let sawUpgrade = false; let sawHealth = 0;
const listening = (srv) => new Promise((r) => srv.listening ? r() : srv.once('listening', r));
const get = (port, route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: route, method, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  r.on('error', reject);
  if (body) r.write(body);
  r.end();
});

before(async () => {
  app = http.createServer((req, res) => {
    if (req.url === '/__design-mode/health') sawHealth += 1; // must never be reached
    if (req.url === '/page') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('etag', '"x"'); res.end(PAGE); return; }
    if (req.url === '/gz') {
      // an upstream that ignores accept-encoding: identity and gzips anyway
      res.setHeader('content-type', 'text/html'); res.setHeader('content-encoding', 'gzip');
      res.end(zlib.gzipSync(PAGE)); return;
    }
    if (req.url === '/nohead') { res.setHeader('content-type', 'text/html'); res.end('<p>fragment</p>'); return; }
    if (req.url === '/img.png') { res.setHeader('content-type', 'image/png'); res.setHeader('content-length', PNG.length); res.end(PNG); return; }
    if (req.url === '/echo') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ host: req.headers.host, enc: req.headers['accept-encoding'], method: req.method, body: b })); }); return; }
    if (req.url === '/go') { res.statusCode = 302; res.setHeader('location', `http://localhost:${appPort}/page?x=1`); res.end(); return; }
    if (req.url === '/go-ext') { res.statusCode = 302; res.setHeader('location', 'https://example.com/a'); res.end(); return; }
    res.statusCode = 404; res.end('nope');
  });
  app.on('upgrade', (req, socket) => {
    sawUpgrade = true;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d)); // echo
    socket.on('end', () => socket.end()); // http upgrade sockets are half-open by default
  });
  app.listen(0, '127.0.0.1'); await listening(app);
  appPort = app.address().port;
  proxy = serveProxy({ proxy: `http://127.0.0.1:${appPort}`, port: 0, queueDir: tmp(), log: () => {} });
  await listening(proxy);
  proxyPort = proxy.address().port;
});
after(() => { proxy.close(); app.close(); proxy.closeAllConnections?.(); app.closeAllConnections?.(); });

const tokenOf = (html) => /"token":"([0-9a-f]{32})"/.exec(html)?.[1];

test('HTML gets the boot snippet before </head> with a token', async () => {
  const r = await get(proxyPort, '/page', { headers: { host: `localhost:${proxyPort}`, accept: 'text/html' } });
  assert.equal(r.status, 200);
  const html = r.body.toString();
  assert.ok(tokenOf(html), 'token present');
  assert.match(html, /"endpoint":"\/__design-mode\/selection"/);
  const snippetAt = html.indexOf('/__design-mode/overlay.js');
  assert.ok(snippetAt > 0 && snippetAt < html.indexOf('</head>'), 'before </head>');
  assert.ok(html.includes('<h1>hi</h1>'), 'page content kept');
  assert.equal(r.headers['content-length'], String(r.body.length), 'length matches the rewritten body');
  assert.equal(r.headers.etag, undefined);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('the injected token authorizes a same-origin POST, and a bad one does not', async () => {
  const html = (await get(proxyPort, '/page', { headers: { host: `localhost:${proxyPort}` } })).body.toString();
  const token = tokenOf(html);
  const h = { host: `localhost:${proxyPort}`, 'content-type': 'application/json', origin: `http://localhost:${proxyPort}` };
  const body = JSON.stringify({ instruction: 'x', seq: 1 });
  assert.equal((await get(proxyPort, SELECTION_ROUTE, { method: 'POST', headers: { ...h, 'x-design-mode-token': token }, body })).status, 200);
  assert.equal((await get(proxyPort, SELECTION_ROUTE, { method: 'POST', headers: { ...h, 'x-design-mode-token': 'bad' }, body })).status, 403);
  assert.equal((await get(proxyPort, SELECTION_ROUTE, { method: 'POST', headers: { ...h, origin: 'https://evil.example', 'x-design-mode-token': token }, body })).status, 403);
});

test('non-HTML passes through byte-identical', async () => {
  const r = await get(proxyPort, '/img.png');
  assert.equal(r.status, 200);
  assert.ok(r.body.equals(PNG));
  assert.equal(r.headers['content-type'], 'image/png');
});

test('upstream is asked for identity encoding; a gzip reply is still rewritten', async () => {
  const echo = JSON.parse((await get(proxyPort, '/echo', { method: 'POST', headers: { 'accept-encoding': 'gzip, br', 'content-type': 'text/plain' }, body: 'hello' })).body);
  assert.equal(echo.enc, 'identity');
  assert.equal(echo.host, `127.0.0.1:${appPort}`, 'Host is rewritten for the app');
  assert.equal(echo.body, 'hello', 'request body is streamed through');
  const r = await get(proxyPort, '/gz', { headers: { host: `localhost:${proxyPort}` } });
  assert.equal(r.headers['content-encoding'], undefined);
  assert.ok(tokenOf(r.body.toString()), 'decoded, then injected');
});

test('a non-local Host gets the HTML without the token or the overlay', async () => {
  const r = await get(proxyPort, '/page', { headers: { host: 'evil.example' } });
  assert.equal(r.status, 200);
  const html = r.body.toString();
  assert.equal(tokenOf(html), undefined);
  assert.ok(!html.includes('__CDM_CONFIG') && !html.includes('overlay.js'));
  assert.ok(html.includes('<h1>hi</h1>'));
});

test('fragments without </head> or </body> still get the snippet', async () => {
  const r = await get(proxyPort, '/nohead', { headers: { host: `localhost:${proxyPort}` } });
  assert.ok(r.body.toString().startsWith('<p>fragment</p><script>'));
  assert.equal(injectSnippet('<body>a</body>', 'S'), '<body>aS</body>');
});

test('/__design-mode/health is answered by the proxy, never forwarded', async () => {
  const before_ = sawHealth;
  const r = await get(proxyPort, HEALTH_ROUTE);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
  assert.equal((await get(proxyPort, '/__design-mode/unknown')).status, 404);
  assert.equal(sawHealth, before_);
});

test('absolute Location headers pointing at the app are rewritten to the proxy', async () => {
  const r = await get(proxyPort, '/go', { headers: { host: `localhost:${proxyPort}` } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `http://localhost:${proxyPort}/page?x=1`);
  const ext = await get(proxyPort, '/go-ext', { headers: { host: `localhost:${proxyPort}` } });
  assert.equal(ext.headers.location, 'https://example.com/a');
});

test('WebSocket upgrades are piped to the app', async () => {
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`GET /hmr HTTP/1.1\r\nHost: localhost:${proxyPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('101') && !buf.includes('ping')) s.write('ping');
      if (buf.endsWith('ping')) { s.destroy(); resolve(buf); }
    });
    s.on('error', reject);
    setTimeout(() => { s.destroy(); reject(new Error(`timeout: ${buf}`)); }, 3000);
  });
  assert.ok(sawUpgrade);
  assert.match(reply, /101 Switching Protocols/);
});

test('502 page when the app is down', async () => {
  const dead = http.createServer(); dead.listen(0, '127.0.0.1'); await listening(dead);
  const port = dead.address().port; dead.close();
  const p = serveProxy({ proxy: `http://127.0.0.1:${port}`, port: 0, queueDir: tmp(), log: () => {} });
  await listening(p);
  const r = await get(p.address().port, '/', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 502);
  assert.match(r.body.toString(), /is not running/);
  assert.match(r.body.toString(), new RegExp(`127\\.0\\.0\\.1:${port}`));
  p.close();
  p.closeAllConnections?.();
});

test('parseAppOrigin accepts bare host:port and rejects non-http', () => {
  assert.equal(parseAppOrigin('localhost:3000').origin, 'http://localhost:3000');
  assert.equal(parseAppOrigin('http://localhost:3000/').origin, 'http://localhost:3000');
  assert.throws(() => parseAppOrigin('ftp://x'));
  assert.throws(() => parseAppOrigin(''));
});
