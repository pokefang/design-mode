#!/usr/bin/env node
/**
 * Wake watcher for agent sessions. Blocks until a selection payload lands in
 * .design-mode/queue/, prints the path(s), and exits 0. The agent runs this as
 * a background process; the harness re-invokes the agent when it exits.
 *
 *   node scripts/wait-for-selection.mjs [queueDir] [timeoutMinutes=15]
 *
 * Exit codes: 0 selection available · 2 timed out (re-arm me) · 1 error
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || path.join(process.cwd(), '.design-mode', 'queue');
const timeoutMin = Number(process.argv[3] || 15);

fs.mkdirSync(dir, { recursive: true });

const pending = () => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    fs.mkdirSync(dir, { recursive: true }); // dir was removed (git clean etc.); keep waiting
    return [];
  }
};

const finish = (files) => {
  for (const f of files) console.log(path.join(dir, f));
  process.exit(0);
};

const existing = pending();
if (existing.length) finish(existing);

const check = () => {
  const files = pending();
  if (files.length) finish(files);
};

try {
  fs.watch(dir, check);
} catch {
  /* fs.watch can be flaky; the poll below still covers us */
}
const poll = setInterval(check, 2000);
poll.unref?.();

setTimeout(() => {
  console.error(`no selection within ${timeoutMin}m`);
  process.exit(2);
}, timeoutMin * 60 * 1000);

// keep the process alive while waiting
setInterval(() => {}, 1 << 30);
