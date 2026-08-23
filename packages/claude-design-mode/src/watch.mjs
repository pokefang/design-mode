/**
 * Wake watcher for agent sessions. Blocks until a selection payload lands in
 * the queue dir, prints the path(s), and exits 0. The agent runs this as a
 * background process; the harness re-invokes the agent when it exits.
 *
 *   claude-design-mode wait [queueDir] [--timeout <minutes>]
 *
 * Exit codes: 0 selection available · 2 timed out (re-arm me) · 1 error
 */
import fs from 'node:fs';
import path from 'node:path';

export function wait({ dir, timeoutMin = 15, out = console.log, err = console.error, exit = process.exit } = {}) {
  const queue = path.resolve(dir || path.join(process.cwd(), '.design-mode', 'queue'));
  fs.mkdirSync(queue, { recursive: true });

  const pending = () => {
    try {
      return fs.readdirSync(queue).filter((f) => f.endsWith('.json')).sort();
    } catch {
      fs.mkdirSync(queue, { recursive: true }); // dir was removed (git clean etc.); keep waiting
      return [];
    }
  };

  const finish = (files) => {
    for (const f of files) out(path.join(queue, f));
    exit(0);
  };

  const existing = pending();
  if (existing.length) return finish(existing);

  const check = () => {
    const files = pending();
    if (files.length) finish(files);
  };

  try {
    fs.watch(queue, check);
  } catch {
    /* fs.watch can be flaky; the poll below still covers us */
  }
  const poll = setInterval(check, 2000);
  poll.unref?.();

  setTimeout(() => {
    err(`no selection within ${timeoutMin}m`);
    exit(2);
  }, timeoutMin * 60 * 1000);

  // keep the process alive while waiting
  setInterval(() => {}, 1 << 30);
}
