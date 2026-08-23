import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from '@babel/core';
import stampPlugin from './stamp.js';

const require = createRequire(import.meta.url);

const OVERLAY_ROUTE = '/__design-mode/overlay.js';
const SELECTION_ROUTE = '/__design-mode/selection';
const HEALTH_ROUTE = '/__design-mode/health';
const MAX_BODY = 512 * 1024;

/**
 * Design Mode dev plugin. Dev-serve only; never touches production builds.
 *
 *  - stamps data-claude-source="relpath:line:col" on JSX host elements
 *  - serves the inspector overlay from the app's own origin
 *  - receives selection payloads on a token-checked endpoint and writes them
 *    to .design-mode/queue/ for the agent (a wake watcher can wait on that dir)
 *
 * Security model for the endpoint: a localhost URL that ultimately feeds an
 * agent is a remote prompt-injection surface, so every request must carry a
 * per-boot random token in a custom header (which also forces a CORS preflight
 * that cross-origin pages fail), any Origin header must match the dev
 * server's own origin, and the Host header must be a local name (so a DNS
 * rebinding page cannot become same-origin with the dev server and read the
 * token out of the HTML). Token comparison is constant-time.
 *
 * Options:
 *   queueDir      where selections are written; default <vite-root>/.design-mode/queue
 *   allowedHosts  extra Host names to accept besides localhost/127.0.0.1/::1/*.localhost
 *   tokens        optional map of design-token families to the project's own custom-property
 *                 patterns, e.g. { color: /^--brand-/, spacing: /^--space-/ }. The overlay
 *                 discovers tokens from the page's CSS on its own (naming conventions, then
 *                 value type); these patterns take precedence when a project's names are
 *                 unusual. Families: color, fontFamily, fontWeight, fontSize, lineHeight,
 *                 tracking, radius, shadow, spacing. Values may be RegExp or regex-source strings.
 */
export default function designMode(options = {}) {
  const token = randomBytes(16).toString('hex');
  const extraHosts = options.allowedHosts || [];
  const tokenHints = Object.fromEntries(
    Object.entries(options.tokens || {})
      .filter(([, v]) => v)
      .map(([k, v]) => [k, v instanceof RegExp ? v.source : String(v)]),
  );
  let root = process.cwd();
  let queueDir = '';
  let counter = 0;

  const stamp = (code, id) => {
    const [file] = id.split('?');
    if (!/\.[jt]sx$/.test(file) || file.includes('node_modules')) return null;
    const relFile = path.relative(root, file).split(path.sep).join('/');
    const result = transformSync(code, {
      filename: file,
      configFile: false,
      babelrc: false,
      sourceMaps: true,
      retainLines: true,
      parserOpts: { sourceType: 'module', plugins: ['jsx', 'typescript'] },
      plugins: [[stampPlugin, { relFile }]],
    });
    return result ? { code: result.code, map: result.map } : null;
  };

  return {
    name: 'design-mode',
    apply: 'serve',
    enforce: 'pre', // must run before @vitejs/plugin-react compiles JSX away

    configResolved(config) {
      root = config.root;
      queueDir = path.resolve(root, options.queueDir || path.join('.design-mode', 'queue'));
    },

    transform(code, id) {
      return stamp(code, id);
    },

    transformIndexHtml() {
      return [
        {
          tag: 'script',
          injectTo: 'head',
          children: `window.__CDM_CONFIG=${JSON.stringify({ endpoint: SELECTION_ROUTE, token, tokens: tokenHints })}`,
        },
        { tag: 'script', injectTo: 'body', attrs: { src: OVERLAY_ROUTE, defer: true } },
      ];
    },

    configureServer(server) {
      fs.mkdirSync(queueDir, { recursive: true });
      const overlayPath = require.resolve('@design-mode/overlay');
      const allowedOrigins = (req) => {
        const host = req.headers.host;
        return host ? [`http://${host}`, `https://${host}`] : [];
      };
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

      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];

        if (url === OVERLAY_ROUTE && req.method === 'GET') {
          res.setHeader('content-type', 'application/javascript');
          res.setHeader('cache-control', 'no-store');
          res.end(fs.readFileSync(overlayPath, 'utf8'));
          return;
        }

        if (url === HEALTH_ROUTE && req.method === 'GET') {
          const pending = fs.existsSync(queueDir)
            ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length
            : 0;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, pending }));
          return;
        }

        if (url === SELECTION_ROUTE) {
          if (req.method === 'OPTIONS') {
            // Usually unreachable: Vite's own CORS middleware answers preflights
            // first, and its restrictive default sends no allow-origin for
            // non-localhost origins, so browsers fail those preflights. This
            // endpoint's security never relies on that layer: the token and the
            // Origin check below hold on their own (verified with direct curls).
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

          if (!isLocalHost(req.headers.host)) {
            res.statusCode = 403;
            res.end('{"error":"host not allowed"}');
            return;
          }
          const origin = req.headers.origin;
          if (origin && !allowedOrigins(req).includes(origin)) {
            res.statusCode = 403;
            res.end('{"error":"origin not allowed"}');
            return;
          }
          if (!tokenMatches(req.headers['x-design-mode-token'])) {
            res.statusCode = 403;
            res.end('{"error":"bad token"}');
            return;
          }
          if (!String(req.headers['content-type'] || '').includes('application/json')) {
            res.statusCode = 415;
            res.end('{"error":"json only"}');
            return;
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
            const file = path.join(queueDir, `${Date.now()}-${String(counter).padStart(6, '0')}-${randomBytes(3).toString('hex')}.json`);
            fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload, null, 2));
            fs.renameSync(`${file}.tmp`, file);
            server.config.logger.info(
              `[design-mode] selection #${payload.seq} -> ${path.relative(root, file)}`,
              { timestamp: true }
            );
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file: path.relative(root, file) }));
          });
          return;
        }

        next();
      });
    },
  };
}
