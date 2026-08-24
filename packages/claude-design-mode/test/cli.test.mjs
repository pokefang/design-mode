import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const run = (cwd, ...args) => execFileSync('node', [cli, ...args], { cwd, encoding: 'utf8' });

test('init is non-destructive and idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-init-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-app', scripts: { dev: 'vite' } }));
  fs.writeFileSync(path.join(dir, 'vite.config.ts'), "export default { server: { port: 3456 } }");
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  const out = run(dir, 'init');
  assert.match(out, /wrote\s+\.claude\/skills\/design-mode\/SKILL\.md/);
  assert.match(out, /launch\.json \(name "my-app", port 3456\)/);
  assert.match(out, /claude-design-mode\/vite/);
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/design-mode/SKILL.md')));
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n'); // untouched
  const launch = JSON.parse(fs.readFileSync(path.join(dir, '.claude/launch.json'), 'utf8'));
  assert.equal(launch.configurations[0].port, 3456);
  // second run: everything skipped, nothing rewritten
  fs.writeFileSync(path.join(dir, '.claude/skills/design-mode/SKILL.md'), 'custom');
  const again = run(dir, 'init');
  assert.match(again, /skipped\s+\.claude\/skills\/design-mode\/SKILL\.md exists/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude/skills/design-mode/SKILL.md'), 'utf8'), 'custom');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n');
});

test('default queue dir lives outside the project, keyed to its path', async () => {
  const { defaultQueueDir } = await import('../src/server.js');
  const a = defaultQueueDir('/tmp/proj-a');
  const b = defaultQueueDir('/tmp/proj-b');
  assert.ok(a.startsWith(os.homedir()));
  assert.ok(!a.includes('/tmp/proj-a'));
  assert.notEqual(a, b);
  assert.equal(a, defaultQueueDir('/tmp/proj-a')); // deterministic
});

test('init without vite points at the standalone server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-init-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'next-app', scripts: { dev: 'next dev -p 3000' } }));
  const out = run(dir, 'init');
  assert.match(out, /serve --app http:\/\/localhost:3000/);
  assert.match(out, /boot\.js/);
});

test('init works when the PACKAGE lives at a path containing a space', () => {
  // regression: overlayPath()/skillDir() once used URL.pathname, which
  // percent-encodes spaces (and breaks Windows drive letters), so init and the
  // overlay route failed for any install under e.g. "~/My Projects/app"
  const spacedPkg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm space ')), 'node_modules', 'claude-design-mode');
  const here = path.dirname(path.dirname(cli));
  fs.cpSync(path.join(here, 'bin'), path.join(spacedPkg, 'bin'), { recursive: true });
  fs.cpSync(path.join(here, 'src'), path.join(spacedPkg, 'src'), { recursive: true });
  fs.cpSync(path.join(here, 'skills'), path.join(spacedPkg, 'skills'), { recursive: true });
  fs.copyFileSync(path.join(here, 'package.json'), path.join(spacedPkg, 'package.json'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm proj '));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'spaced', scripts: { dev: 'vite' }, devDependencies: { vite: '^6' } }));
  const out = execFileSync('node', [path.join(spacedPkg, 'bin', 'cli.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
  assert.match(out, /wrote\s+\.claude\/skills\/design-mode\/SKILL\.md/);
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/design-mode/SKILL.md')));
  assert.ok(fs.existsSync(execFileSync('node', [path.join(spacedPkg, 'bin', 'cli.mjs'), 'overlay-path'], { cwd: dir, encoding: 'utf8' }).trim()));
  // and a Vite app with no explicit port gets the Vite default
  assert.match(out, /port 5173/);
  const launch = JSON.parse(fs.readFileSync(path.join(dir, '.claude/launch.json'), 'utf8'));
  assert.equal(launch.configurations[0].port, 5173);
});

test('overlay-path and skill-path resolve to shipped files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-paths-'));
  assert.ok(fs.existsSync(run(dir, 'overlay-path').trim()));
  assert.ok(fs.existsSync(path.join(run(dir, 'skill-path').trim(), 'SKILL.md')));
});
