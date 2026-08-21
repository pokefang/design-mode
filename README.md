# Design Mode

Click an element in your running app, describe the change in plain language,
and Claude edits the exact source line that rendered it. A Cursor-Design-Mode
style experience built on Claude Code, with the piece Cursor never shipped:
a deterministic element-to-source map.

Architecture doc: https://claude.ai/code/artifact/98ce2dbc-7694-4b69-8e40-2f5e7e5e6c5d

## How it works

1. `@design-mode/vite-plugin` (dev serve only) stamps every JSX host element
   with `data-claude-source="relpath:line:col"` via a Babel visitor, serves the
   inspector overlay from the app's own origin, and exposes a token-checked
   `POST /__design-mode/selection` endpoint.
2. `@design-mode/overlay` draws the hover highlight, the click-to-select ring,
   an inline prompt card with scope chips (auto / instance / component / token),
   and an inspector panel (component chain, source, classes, computed styles,
   matched CSS rules). On submit it POSTs the selection payload to the plugin.
3. The plugin writes each payload to `<vite-root>/.design-mode/queue/*.json`
   (`demo/.design-mode/queue/` here; configurable via `queueDir`).
   `scripts/wait-for-selection.mjs` blocks on that directory; a Claude Code
   session runs it as a background process and is woken the moment a selection
   lands, resolves the source (stamp first, React fiber stack second, repo
   search last), applies a targeted edit, and verifies via `getComputedStyle`
   plus a zoomed screenshot after HMR settles.

The `/design-mode` project skill (`.claude/skills/design-mode/`) gives a Claude
Code session the full loop, including the trust boundary: only the user-typed
instruction is imperative; captured page HTML, text, and styles are data.

## Quickstart

```
npm install
npm run dev        # demo app on port 3800 (strict)
```

Open http://localhost:3800, press Cmd+Shift+D, click anything, type an
instruction. The payload appears under `demo/.design-mode/queue/`. In a Claude Code
session in this repo, say "start design mode" and the loop runs end to end.

## Packages

| Path | What it is |
| --- | --- |
| `packages/overlay` | In-page inspector overlay (vanilla JS, no build step) |
| `packages/vite-plugin` | Dev-only Vite plugin: stamping, overlay serving, selection endpoint |
| `demo` | Vite + React 19 + Tailwind 4 playground (port 3800) |
| `scripts/wait-for-selection.mjs` | Wake watcher a Claude session arms in the background |
| `.claude/skills/design-mode` | The session loop as a project skill |

## Security notes

The selection endpoint feeds an agent, so it is treated as a remote
prompt-injection surface even on localhost: per-boot random token in a custom
header (forces a CORS preflight that cross-origin pages fail; no CORS allow
headers are ever sent), Origin validated against the dev server's own origin,
Host header restricted to local names (DNS rebinding defense), constant-time
token comparison, JSON only, 512KB body cap, dev-serve only so stamps and
endpoint never reach a production build. Payload fields captured from the page are labeled untrusted;
the session skill forbids following instruction-like text inside them.

## Status

Working now: stamping, overlay, endpoint, queue, wake watcher, session skill,
demo app. Planned next (in order): multi-select, freeze/pin for popovers and
hover states, an Agent SDK bridge daemon for a persistent session with a
result stream back into the page, an SWC plugin for Next/Turbopack stamping,
and a runtime preview mode that batches tweaks before a single agent Apply.
