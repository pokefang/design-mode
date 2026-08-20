import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
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
 * that cross-origin pages fail), and any Origin header must match the dev
 * server's own origin.
 */
export default function designMode(options = {}) {
  const token = randomBytes(16).toString('hex');
  let root = process.cwd();
  let queueDir = '';

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
      queueDir = path.join(root, '.design-mode', 'queue');
    },

    transform(code, id) {
      return stamp(code, id);
    },

    transformIndexHtml() {
      return [
        {
          tag: 'script',
          injectTo: 'head',
          children: `window.__CDM_CONFIG=${JSON.stringify({ endpoint: SELECTION_ROUTE, token })}`,
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

          const origin = req.headers.origin;
          if (origin && !allowedOrigins(req).includes(origin)) {
            res.statusCode = 403;
            res.end('{"error":"origin not allowed"}');
            return;
          }
          if (req.headers['x-design-mode-token'] !== token) {
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
            const file = path.join(queueDir, `${Date.now()}-${payload.seq}.json`);
            fs.writeFileSync(file, JSON.stringify(payload, null, 2));
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
