import http from 'node:http';
import path from 'node:path';
import { createHandler, newToken, configScript, OVERLAY_ROUTE, SELECTION_ROUTE } from './server.js';

const BOOT_ROUTE = '/__design-mode/boot.js';

/**
 * Standalone Design Mode server for apps that are not on Vite (Next, Remix,
 * Rails, Django, a static site...). The app adds one script tag in development:
 *
 *   <script src="http://localhost:3850/__design-mode/boot.js"></script>
 *
 * boot.js carries this boot's token and loads the overlay; selections POST back
 * here and land in the queue dir exactly as with the Vite plugin. There is no
 * JSX stamping in this mode, so sources resolve from React debug stacks or the
 * DOM path plus repo search (the skill handles both).
 *
 * Only pages from --app origins get the token: boot.js is served with a token
 * only when the request's Referer/Origin is an allowed origin, and the
 * selection endpoint accepts POSTs only from those origins.
 */
export function serve({ port = 3850, apps = [], queueDir, root = process.cwd(), log = console.log } = {}) {
  const token = newToken();
  const apps_ = apps.map((a) => a.replace(/\/$/, ''));
  const dir = path.resolve(root, queueDir || path.join('.design-mode', 'queue'));
  const handle = createHandler({ token, queueDir: dir, root, allowOrigins: apps_, cors: true, log });

  const referrerOrigin = (req) => {
    const ref = req.headers.origin || req.headers.referer;
    if (!ref) return null;
    try { return new URL(ref).origin; } catch { return null; }
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === BOOT_ROUTE && req.method === 'GET') {
      const from = referrerOrigin(req);
      const allowed = from && apps_.includes(from);
      res.setHeader('content-type', 'application/javascript');
      res.setHeader('cache-control', 'no-store');
      if (!allowed) {
        res.end(`console.warn('[design-mode] ${from || 'this page'} is not an allowed app origin; start the server with --app <origin>');`);
        return;
      }
      const self = `http://localhost:${port}`;
      res.end([
        configScript({ endpoint: `${self}${SELECTION_ROUTE}`, token }) + ';',
        `(function(){var s=document.createElement('script');s.src=${JSON.stringify(self + OVERLAY_ROUTE)};s.defer=true;document.head.appendChild(s);})();`,
      ].join('\n'));
      return;
    }
    if (handle(req, res)) return;
    res.statusCode = 404;
    res.end('not found');
  });

  server.listen(port, '127.0.0.1', () => {
    log(`[design-mode] serving on http://localhost:${port}`);
    log(`[design-mode] queue: ${path.relative(root, dir) || '.'}`);
    if (apps_.length) log(`[design-mode] allowed apps: ${apps_.join(', ')}`);
    else log('[design-mode] no --app origins given: pages cannot load the overlay until you pass --app http://localhost:<your-port>');
    log(`[design-mode] add to your app (dev only): <script src="http://localhost:${port}${BOOT_ROUTE}"></script>`);
  });
  return server;
}
