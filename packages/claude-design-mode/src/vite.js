import path from 'node:path';
import { transformSync } from '@babel/core';
import stampPlugin from './stamp.js';
import { createHandler, newToken, serializeTokenHints, configScript, OVERLAY_ROUTE, SELECTION_ROUTE } from './server.js';

/**
 * Design Mode Vite plugin. Dev-serve only; never touches production builds.
 *
 *  - stamps data-claude-source="relpath:line:col" on JSX host elements
 *  - serves the inspector overlay from the app's own origin
 *  - receives selection payloads on a token-checked endpoint and writes them
 *    to .design-mode/queue/ for the agent (`claude-design-mode wait` blocks on it)
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
 *   stamp         set false to skip JSX stamping (non-React apps); the overlay then resolves
 *                 sources from React debug stacks or the DOM path instead
 */
export default function designMode(options = {}) {
  const token = newToken();
  const tokenHints = serializeTokenHints(options.tokens);
  let root = process.cwd();
  let queueDir = '';

  const stamp = (code, id) => {
    if (options.stamp === false) return null;
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
        { tag: 'script', injectTo: 'head', children: configScript({ endpoint: SELECTION_ROUTE, token, tokens: tokenHints }) },
        { tag: 'script', injectTo: 'body', attrs: { src: OVERLAY_ROUTE, defer: true } },
      ];
    },

    configureServer(server) {
      const handle = createHandler({
        token,
        queueDir,
        root,
        allowedHosts: options.allowedHosts,
        log: (msg) => server.config.logger.info(msg, { timestamp: true }),
      });
      server.middlewares.use((req, res, next) => { if (!handle(req, res)) next(); });
      server.config.logger.info(`[design-mode] queue: ${path.relative(root, queueDir) || '.'}  (toggle with Cmd+D in the page)`, { timestamp: true });
    },
  };
}
