import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = new URL('../bin/cli.mjs', import.meta.url).pathname;
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
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n.design-mode/\n');
  const launch = JSON.parse(fs.readFileSync(path.join(dir, '.claude/launch.json'), 'utf8'));
  assert.equal(launch.configurations[0].port, 3456);
  // second run: everything skipped, nothing rewritten
  fs.writeFileSync(path.join(dir, '.claude/skills/design-mode/SKILL.md'), 'custom');
  const again = run(dir, 'init');
  assert.match(again, /skipped\s+\.claude\/skills\/design-mode\/SKILL\.md exists/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude/skills/design-mode/SKILL.md'), 'utf8'), 'custom');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n.design-mode/\n');
});

test('init without vite points at the standalone server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-init-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'next-app', scripts: { dev: 'next dev -p 3000' } }));
  const out = run(dir, 'init');
  assert.match(out, /serve --app http:\/\/localhost:3000/);
  assert.match(out, /boot\.js/);
});

test('overlay-path and skill-path resolve to shipped files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-paths-'));
  assert.ok(fs.existsSync(run(dir, 'overlay-path').trim()));
  assert.ok(fs.existsSync(path.join(run(dir, 'skill-path').trim(), 'SKILL.md')));
});
