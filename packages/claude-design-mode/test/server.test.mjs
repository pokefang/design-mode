import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandler, newToken, SELECTION_ROUTE, OVERLAY_ROUTE, HEALTH_ROUTE } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-'));
const listen = (handle) => new Promise((resolve) => {
  const srv = http.createServer((req, res) => { if (!handle(req, res)) { res.statusCode = 404; res.end(); } });
  srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const req = (port, route, { method = 'GET', headers = {}, body, host } = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(host ? { host } : {}), ...headers } }, (res) => {
    let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  if (body) r.write(body);
  r.end();
});
const payload = JSON.stringify({ instruction: 'make it blue', seq: 1 });
const json = { 'content-type': 'application/json' };

test('serves the overlay and health', async () => {
  const queueDir = tmp();
  const { srv, port } = await listen(createHandler({ token: newToken(), queueDir }));
  const o = await req(port, OVERLAY_ROUTE);
  assert.equal(o.status, 200);
  assert.match(o.body, /__claudeDesign/);
  const h = await req(port, HEALTH_ROUTE);
  assert.equal(JSON.parse(h.body).pending, 0);
  srv.close();
});

test('selection endpoint: token, origin, host, shape, then writes the queue file', async () => {
  const token = newToken();
  const queueDir = tmp();
  const { srv, port } = await listen(createHandler({ token, queueDir }));
  const self = `http://localhost:${port}`;
  assert.equal((await req(port, SELECTION_ROUTE, { method: 'POST', headers: json, body: payload })).status, 403, 'no token');
  assert.equal((await req(port, SELECTION_ROUTE, { method: 'POST', headers: { ...json, 'x-design-mode-token': 'nope' }, body: payload })).status, 403, 'bad token');
  assert.equal((await req(port, SELECTION_ROUTE, { method: 'POST', headers: { ...json, 'x-design-mode-token': token, origin: 'https://evil.example' }, body: payload })).status, 403, 'foreign origin');
  assert.equal((await req(port, SELECTION_ROUTE, { method: 'POST', host: 'evil.example', headers: { ...json, 'x-design-mode-token': token }, body: payload })).status, 403, 'rebinding host');
  assert.equal((await req(port, SELECTION_ROUTE, { method: 'POST', headers: { ...json, 'x-design-mode-token': token }, body: '{"nope":1}' })).status, 422, 'shape');
  assert.equal((await req(port, SELECTION_ROUTE, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-design-mode-token': token }, body: payload })).status, 415, 'json only');
  const ok = await req(port, SELECTION_ROUTE, { method: 'POST', headers: { ...json, 'x-design-mode-token': token, origin: self, host: `localhost:${port}` }, body: payload });
  assert.equal(ok.status, 200);
  const files = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf8')).instruction, 'make it blue');
  assert.equal(JSON.parse((await req(port, HEALTH_ROUTE)).body).pending, 1);
  srv.close();
});

test('cors mode: only allowed app origins get preflight and echo', async () => {
  const token = newToken();
  const queueDir = tmp();
  const { srv, port } = await listen(createHandler({ token, queueDir, cors: true, allowOrigins: ['http://localhost:3000'] }));
  const pre = await req(port, SELECTION_ROUTE, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:3000');
  const evil = await req(port, SELECTION_ROUTE, { method: 'OPTIONS', headers: { origin: 'http://localhost:4000' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const post = await req(port, SELECTION_ROUTE, { method: 'POST', headers: { ...json, 'x-design-mode-token': token, origin: 'http://localhost:3000' }, body: payload });
  assert.equal(post.status, 200);
  assert.equal(post.headers['access-control-allow-origin'], 'http://localhost:3000');
  const bad = await req(port, SELECTION_ROUTE, { method: 'POST', headers: { ...json, 'x-design-mode-token': token, origin: 'http://localhost:4000' }, body: payload });
  assert.equal(bad.status, 403);
  srv.close();
});
