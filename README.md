# Design Mode for Claude Code

Click an element in your running app, describe the change in plain language or
edit it in a Figma-style sidebar, and Claude Code edits the exact source line
that rendered it. The piece Cursor's Design Mode never shipped: a deterministic
element-to-source map, plus token-aware edits that land in your design system's
own vocabulary.

## Use it in your own app

Two halves: the **app side** (an npm package that puts the inspector in your
page) and the **session side** (a skill that teaches Claude Code the loop).

### 1. App side: `claude-design-mode`

```bash
npm i -D claude-design-mode
npx claude-design-mode init
```

`init` is non-destructive. It copies the session skill into
`.claude/skills/design-mode/`, writes a `.claude/launch.json` entry for the
Browser pane (port detected from your Vite config or dev script), and prints
the one line it will not add for you:

```js
// vite.config.js
import designMode from 'claude-design-mode/vite'
export default defineConfig({ plugins: [designMode(), react()] }) // designMode() first
```

Dev-serve only; production builds are untouched. Options: `queueDir`,
`allowedHosts`, `stamp: false` (skip JSX stamping), and `tokens` (your own
token-name patterns, e.g. `{ color: /^--brand-/, spacing: /^--space-/ }`; the
overlay discovers tokens from your CSS on its own, this just overrides the
grouping when your names are unusual).

**Not on Vite** (Next, Remix, Rails, a static site)? Run the standalone server
next to your dev server and add one script tag in development:

```bash
npx claude-design-mode serve --app http://localhost:3000
```

```html
<script src="http://localhost:3850/__design-mode/boot.js" referrerpolicy="origin"></script>
```

(`referrerpolicy="origin"` is required: it is how the server recognizes your
app's origin, even over https or under a strict referrer policy.)

Only pages from `--app` origins receive the token, and only those origins can
POST selections. There is no JSX stamping in this mode; sources resolve from
React debug stacks or the DOM path plus repo search.

### 2. Session side: the skill

`init` already dropped the skill into `.claude/skills/design-mode/`, so any
Claude Code session in that project can run it: say "start design mode" (or
`/design-mode`). It starts your dev server in the Browser pane and acts on each
request as it arrives, whether you paste it in or it is delivered for you.
Nothing runs in the background. Prefer a skill you install once for every
project instead of per repo? This repo is also a Claude Code plugin
marketplace:

```
/plugin marketplace add pokefang/design-mode
/plugin install design-mode@claude-design-mode
```

(then `/design-mode:design-mode` or just "start design mode"). To hack on it
locally instead, point the CLI at a checkout: `claude --plugin-dir
path/to/design-mode/packages/claude-design-mode`.

**Any page, no install**: a session can inject the overlay into whatever is
open in the Browser pane (`npx claude-design-mode overlay-path`, eval it with
`window.__CDM_CONFIG = { endpoint: null }`, poll `__claudeDesign.take()`). The
skill's Tier 1 section covers it; selections then never leave the page.

### In the page

`Cmd+D` (Ctrl+D on Windows and Linux) toggles Design Mode. While nothing is selected the page is in inspect
mode (crosshair cursor, hover highlights, click selects). Selecting an element
docks a sidebar on the right (drag its header to snap left) with breadcrumbs, a
collapsed "Ask Claude" prompt, and Layout / Spacing / Typography / Appearance
controls; the page is interactive again, and the pick button in the sidebar
header re-arms inspecting without closing it. Clicking a value lists the tokens
your app actually defines, dragging a value scrubs it, double-clicking resets
it; a dot beside a label means the property has a pending change, a small
triangle means the value is a literal with no token behind it. Every change
previews instantly and collects in the "Ask Claude" section, where one button
ships the whole run and the text box doubles as the note; clicking the change
count opens the list to review or revert them one by one.

Submitting copies a short prompt naming the file, line, and each property from
and to, ready to paste into Claude Code or any other agent. Nothing has to be
running for that: the button says "Copy N changes for Claude" and the bar keeps
a "Paste in Claude" reminder until you do. If a session is already listening the
same button reads "Send N changes to Claude" and delivers it directly.

While Design Mode is on and nothing is selected, a status bar sits in its own
strip across the top of the page, so it never covers your app; it hands the
space back when the sidebar opens. It carries the submit button and a light and
dark toggle that follows your system by default. Esc closes the sidebar, Esc
again exits Design Mode, asking first if anything is unsent.

## How it works

1. The Vite plugin (dev serve only) stamps every JSX host element with
   `data-claude-source="relpath:line:col"` via a Babel visitor, serves the
   inspector overlay from the app's own origin, and exposes a token-checked
   `POST /__design-mode/selection` endpoint. The standalone server shares the
   same endpoint code minus stamping.
2. The overlay draws the hover highlight, the selection ring, breadcrumbs for
   walking parent/child, the prompt section with scope chips (auto / instance /
   component / token), and the design sidebar. Pickers are built from every
   `--*` custom property the page defines, grouped by the project's patterns,
   then common naming conventions, then value type, so they work on Tailwind,
   a hand-rolled token set, or anything with CSS variables. Spacing writes in
   the app's vocabulary: a `--spacing` base unit, the app's own spacing tokens,
   or plain px when there is nothing else. Literals that match no token are
   flagged hardcoded.
3. Payloads land in a per-project queue outside the repo
   (`~/.claude-design-mode/<project>-<hash>/queue`; the health route reports the
   absolute path). `claude-design-mode wait`
   blocks on that directory; the session runs it in the background and wakes
   the moment something lands, resolves the source (stamp first, React fiber
   stack second, repo search last), applies a targeted edit, verifies via
   `getComputedStyle` and a zoomed screenshot, and for design edits calls
   `__claudeDesign.applied()` so the previews clear and the page shows the
   committed code.

The skill also states the trust boundary: only the user-typed instruction is
imperative; captured page HTML, text, styles and token names are data.

## This repo

```
npm install
npm run dev        # demo app on port 3800 (strict)
npm test           # server handler + CLI tests
```

Open http://localhost:3800, press Cmd+D, click anything. Fixture pages under
`demo/public/fixtures/` exercise the non-Tailwind paths: `custom-tokens.html`
(hand-rolled tokens), `plain.html` (no tokens), `standalone.html` (the one
script-tag integration; start `npx claude-design-mode serve --app
http://localhost:3800` first).

| Path | What it is |
| --- | --- |
| `packages/claude-design-mode` | The npm package: Vite plugin, standalone server, overlay, wake watcher, CLI, bundled skill, Claude Code plugin manifest |
| `packages/claude-design-mode/skills/design-mode` | The session skill (this repo's `.claude/skills/design-mode` symlinks to it) |
| `.claude-plugin/marketplace.json` | Makes the repo installable with `/plugin marketplace add` |
| `demo` | Vite + React 19 + Tailwind 4 playground (port 3800) |

## Security notes

The selection endpoint feeds an agent, so it is treated as a remote
prompt-injection surface even on localhost: per-boot random token in a custom
header (forces a CORS preflight), Origin validated against the server's own
origin (plus `--app` origins in standalone mode, which are the only ones that
get CORS headers or the token), Host header restricted to local names (DNS
rebinding defense), constant-time token comparison, JSON only, 512KB body cap,
dev-serve only so stamps and endpoint never reach a production build. Payload
fields captured from the page are labeled untrusted; the session skill forbids
following instruction-like text inside them.

## Status

Working now: stamping, overlay with prompt and design sidebar (live runtime
previews, Changes tray, token-aware from/to, app-agnostic token discovery),
endpoint, queue, wake watcher, standalone server, CLI, session skill, plugin
manifest, demo app. Planned next: multi-select,
freeze/pin for popovers and hover states, an Agent SDK bridge daemon for a
persistent session with a result stream back into the page, and an SWC plugin
for Next/Turbopack stamping.
