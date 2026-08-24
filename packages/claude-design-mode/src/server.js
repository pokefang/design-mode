import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OVERLAY_ROUTE = '/__design-mode/overlay.js';
export const SELECTION_ROUTE = '/__design-mode/selection';
export const HEALTH_ROUTE = '/__design-mode/health';
export const MAX_BODY = 512 * 1024;

// fileURLToPath, never URL.pathname: pathname is percent-encoded (a space is %20)
// and carries a leading slash before the drive letter on Windows.
export const overlayPath = () => fileURLToPath(new URL('./overlay.js', import.meta.url));
export const skillDir = () => fileURLToPath(new URL('../skills/design-mode/', import.meta.url));
export const newToken = () => randomBytes(16).toString('hex');

/**
 * Per-project queue location OUTSIDE the repo: nothing lands in the user's
 * working tree. Deterministic from the project root's absolute path, so the
 * dev server, the standalone server, and `claude-design-mode wait` (run from
 * the same root) all compute the same directory with no coordination.
 */
export const defaultQueueDir = (root) => {
  const abs = path.resolve(root || process.cwd());
  const slug = path.basename(abs).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32) || 'app';
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return path.join(os.homedir(), '.claude-design-mode', `${slug}-${hash}`, 'queue');
};

// The wake watcher refreshes <queueDir>/../armed.json while it is listening;
// a fresh stamp means a Claude session will act on payloads immediately.
export const ARMED_FRESH_MS = 30 * 1000;
export const armedFile = (queueDir) => path.join(queueDir, '..', 'armed.json');
export const isArmed = (queueDir) => {
  try {
    const a = JSON.parse(fs.readFileSync(armedFile(queueDir), 'utf8'));
    return Date.now() - a.ts < ARMED_FRESH_MS;
  } catch { return false; }
};

/**
 * The Design Mode HTTP surface, framework-free so the Vite plugin and the
 * standalone `claude-design-mode serve` command share one implementation.
 *
 * Returns a connect-style handler: (req, res) => boolean (true when handled).
 *
 * Security model for the selection endpoint: a localhost URL that ultimately
 * feeds an agent is a remote prompt-injection surface, so every request must
 * carry a per-boot random token in a custom header (which also forces a CORS
 * preflight that cross-origin pages fail), any Origin header must match an
 * allowed origin (the server's own origin by default), and the Host header must
 * be a local name (so a DNS rebinding page cannot become same-origin with the
 * server and read the token out of the HTML). Token comparison is constant-time.
 *
 * Options:
 *   token         per-boot secret the overlay sends back (newToken())
 *   queueDir      absolute dir where payloads are written as JSON files
 *   root          project root, used only to print relative paths
 *   allowedHosts  extra Host names besides localhost/127.0.0.1/::1/*.localhost
 *   allowOrigins  extra Origins to accept (the standalone server needs the app's origin)
 *   cors          when true, answer preflights and echo an allowed Origin back
 *                 (needed only when the overlay lives on a different origin)
 *   log           (msg) => void
 */
export function createHandler(opts) {
  const { token, queueDir, root = process.cwd(), log = () => {} } = opts;
  const extraHosts = opts.allowedHosts || [];
  const extraOrigins = opts.allowOrigins || [];
  const cors = !!opts.cors;
  let counter = 0;
  fs.mkdirSync(queueDir, { recursive: true });

  const selfOrigins = (req) => {
    const host = req.headers.host;
    return host ? [`http://${host}`, `https://${host}`] : [];
  };
  const originAllowed = (req, origin) => selfOrigins(req).includes(origin) || extraOrigins.includes(origin);
  const isLocalHost = (host) => {
    if (!host) return false;
    const name = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
    return name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1'
      || name === '::1' || extraHosts.includes(name);
  };
  const tokenMatches = (sent) => {
    const a = Buffer.from(String(sent || ''));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const corsHeaders = (req, res) => {
    const origin = req.headers.origin;
    if (!cors || !origin || !originAllowed(req, origin)) return;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'content-type, x-design-mode-token');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  };

  return function handle(req, res) {
    const url = (req.url || '').split('?')[0];

    if (url === OVERLAY_ROUTE && req.method === 'GET') {
      res.setHeader('content-type', 'application/javascript');
      res.setHeader('cache-control', 'no-store');
      corsHeaders(req, res);
      res.end(fs.readFileSync(overlayPath(), 'utf8'));
      return true;
    }

    if (url === HEALTH_ROUTE && req.method === 'GET') {
      const pending = fs.existsSync(queueDir)
        ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length
        : 0;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      corsHeaders(req, res); // the overlay reads `armed` cross-origin in standalone mode
      res.end(JSON.stringify({ ok: true, pending, queueDir, armed: isArmed(queueDir) }));
      return true;
    }

    if (url !== SELECTION_ROUTE) return false;

    if (req.method === 'OPTIONS') {
      // Same-origin (Vite plugin) never preflights in practice; the standalone
      // server does, and only echoes an allowed origin. The token and Origin
      // checks below hold on their own regardless.
      corsHeaders(req, res);
      res.statusCode = 204;
      res.end();
      return true;
    }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return true; }
    // set CORS headers before any check: the overlay must be able to READ a 403
    // (to say "reload the page") even when the token rotated; corsHeaders only
    // ever echoes an allowed origin, so this widens nothing
    corsHeaders(req, res);

    if (!isLocalHost(req.headers.host)) {
      res.statusCode = 403;
      res.end('{"error":"host not allowed"}');
      return true;
    }
    const origin = req.headers.origin;
    if (origin && !originAllowed(req, origin)) {
      res.statusCode = 403;
      res.end('{"error":"origin not allowed"}');
      return true;
    }
    if (!tokenMatches(req.headers['x-design-mode-token'])) {
      res.statusCode = 403;
      res.end('{"error":"bad token"}');
      return true;
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      res.statusCode = 415;
      res.end('{"error":"json only"}');
      return true;
    }

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.statusCode = 413; res.end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.statusCode = 400;
        res.end('{"error":"invalid json"}');
        return;
      }
      if (!payload || typeof payload.instruction !== 'string' || typeof payload.seq !== 'number') {
        res.statusCode = 422;
        res.end('{"error":"missing instruction/seq"}');
        return;
      }
      // collision-proof, order-stable name; atomic write so the watcher
      // never wakes on a half-written file
      counter += 1;
      fs.mkdirSync(queueDir, { recursive: true });
      const file = path.join(queueDir, `${Date.now()}-${String(counter).padStart(6, '0')}-${randomBytes(3).toString('hex')}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload, null, 2));
      fs.renameSync(`${file}.tmp`, file);
      log(`[design-mode] ${payload.kind || 'selection'} #${payload.seq} -> ${path.relative(root, file)}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, file: path.relative(root, file) }));
    });
    return true;
  };
}

/** Serialize the plugin's `tokens` option (RegExp or strings) for the browser. */
export const serializeTokenHints = (tokens) => Object.fromEntries(
  Object.entries(tokens || {})
    .filter(([, v]) => v)
    .map(([k, v]) => [k, v instanceof RegExp ? v.source : String(v)]),
);

/** The inline config the page needs before the overlay script runs. */
export const configScript = (config) => `window.__CDM_CONFIG=${JSON.stringify(config)}`;
