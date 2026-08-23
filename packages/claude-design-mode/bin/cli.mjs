#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { overlayPath, skillDir } from '../src/server.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const flagAll = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const positional = (n) => args.slice(1).filter((a, i, arr) => !a.startsWith('--') && (i === 0 || !arr[i - 1].startsWith('--')))[n];

const HELP = `claude-design-mode ${pkg.version}

  init [--port N] [--force]   set up this project: copies the Claude Code skill into
                              .claude/skills/design-mode, adds a .claude/launch.json entry,
                              ignores .design-mode/, and prints the one config line to add
  wait [queueDir] [--timeout M]
                              block until a selection lands in the queue (agent wake watcher)
  serve --app <origin> [--port 3850] [--queue dir]
                              standalone server for non-Vite apps (one <script> tag)
  overlay-path                print the overlay's absolute path (for manual injection)
  skill-path                  print the bundled skill's directory
`;

const cwd = process.cwd();
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');
const say = (s) => console.log(s);

const detectPort = () => {
  const explicit = flag('port');
  if (explicit && explicit !== true) return Number(explicit);
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
    if (!exists(f)) continue;
    const m = /port\s*:\s*(\d{2,5})/.exec(read(f));
    if (m) return Number(m[1]);
  }
  if (exists('package.json')) {
    try {
      const dev = JSON.parse(read('package.json')).scripts?.dev || '';
      const m = /(?:--port|-p)[ =](\d{2,5})/.exec(dev);
      if (m) return Number(m[1]);
    } catch { /* ignore */ }
  }
  return null;
};
const viteConfigFile = () => ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'].find(exists) || null;
const projectName = () => {
  try { return JSON.parse(read('package.json')).name || path.basename(cwd); } catch { return path.basename(cwd); }
};

const init = () => {
  const force = !!flag('force');
  const done = [];
  const skipped = [];

  // 1. the session skill
  const skillTarget = path.join(cwd, '.claude', 'skills', 'design-mode', 'SKILL.md');
  const skillSource = path.join(skillDir(), 'SKILL.md');
  if (exists(skillTarget) && !force) skipped.push(`.claude/skills/design-mode/SKILL.md exists (use --force to overwrite)`);
  else {
    fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
    fs.copyFileSync(skillSource, skillTarget);
    done.push('.claude/skills/design-mode/SKILL.md');
  }

  // 2. a Browser-pane launch config so the session can start the dev server
  const launchFile = path.join(cwd, '.claude', 'launch.json');
  const port = detectPort();
  if (exists(launchFile)) skipped.push('.claude/launch.json exists (left as is)');
  else if (!port) skipped.push('.claude/launch.json not written: could not detect the dev port (pass --port N)');
  else {
    const launch = { version: '0.0.1', configurations: [{ name: projectName(), runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port }] };
    fs.mkdirSync(path.dirname(launchFile), { recursive: true });
    fs.writeFileSync(launchFile, JSON.stringify(launch, null, 2) + '\n');
    done.push(`.claude/launch.json (name "${projectName()}", port ${port})`);
  }

  // 3. keep the queue out of git
  const gi = path.join(cwd, '.gitignore');
  const giText = exists(gi) ? read(gi) : '';
  if (/^\.design-mode\/?$/m.test(giText)) skipped.push('.gitignore already ignores .design-mode/');
  else {
    fs.writeFileSync(gi, giText + (giText && !giText.endsWith('\n') ? '\n' : '') + '.design-mode/\n');
    done.push('.gitignore (+ .design-mode/)');
  }

  say(`claude-design-mode init\n`);
  for (const d of done) say(`  wrote    ${d}`);
  for (const s of skipped) say(`  skipped  ${s}`);

  // 4. the one thing this tool will not do for you: touch your build config
  const vc = viteConfigFile();
  say('');
  if (vc) {
    say(`Add the plugin to ${vc} (dev-serve only; it never touches builds):\n`);
    say(`  import designMode from 'claude-design-mode/vite'\n  export default defineConfig({ plugins: [designMode(), /* ...your plugins */] })\n`);
    say('Put designMode() first so JSX is stamped before the React plugin compiles it.');
  } else {
    say('No vite.config found. For any other dev server, run the standalone server alongside it:\n');
    say(`  npx claude-design-mode serve --app http://localhost:${port || 3000}\n`);
    say('and add this to your app shell in development only:\n');
    say('  <script src="http://localhost:3850/__design-mode/boot.js"></script>');
  }
  say('\nThen, in a Claude Code session in this project, say "start design mode".');
  say('In the page: Cmd+D toggles the inspector, click anything, describe the change.');
};

switch (cmd) {
  case 'init': init(); break;
  case 'wait': {
    const { wait } = await import('../src/watch.mjs');
    const t = flag('timeout');
    wait({ dir: positional(0), timeoutMin: t && t !== true ? Number(t) : 15 });
    break;
  }
  case 'serve': {
    const { serve } = await import('../src/serve.mjs');
    const p = flag('port');
    const q = flag('queue');
    serve({ port: p && p !== true ? Number(p) : 3850, apps: flagAll('app'), queueDir: q && q !== true ? q : undefined });
    break;
  }
  case 'overlay-path': say(overlayPath()); break;
  case 'skill-path': say(skillDir().replace(/\/$/, '')); break;
  case undefined:
  case 'help':
  case '--help':
  case '-h': say(HELP); break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    say(HELP);
    process.exit(1);
}
