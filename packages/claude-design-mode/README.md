# claude-design-mode

Click an element in your running app, describe the change or edit it in a
Figma-style sidebar, and Claude Code edits the exact source line that rendered
it. Inspector overlay + Vite plugin (or a standalone server for any stack) +
the Claude Code session skill, in one package. Submitting copies a short prompt
for you to paste; nothing has to run in the background.

```bash
npm i -D claude-design-mode
npx claude-design-mode init
```

`init` copies the session skill into `.claude/skills/design-mode/`, writes a
`.claude/launch.json` entry for the Browser pane, and prints the one line to
add to your Vite config:

```js
import designMode from 'claude-design-mode/vite'
export default defineConfig({ plugins: [designMode(), react()] }) // designMode() first
```

Not on Vite? Run `npx claude-design-mode serve --app http://localhost:3000`
next to your dev server and add
`<script src="http://localhost:3850/__design-mode/boot.js" referrerpolicy="origin"></script>`
in development (the `referrerpolicy` is how the server recognizes your app,
even over https or with a strict referrer policy).

Then, in a Claude Code session in the project, say "start design mode". In the
page, `Cmd+D` (Ctrl+D on Windows and Linux) toggles the inspector: click
anything, type an instruction or edit values (tokens are discovered from your
own CSS), and submit. Submitting copies a short prompt naming the file, the
line, and each property from and to, ready to paste into Claude Code or any
other agent:

```
Update the source:

PricingSection (src/components/PricingSection.jsx:28)
- font-size: text-lg -> text-4xl

Note: make it as loud as the hero.
```

A status bar in its own strip across the top keeps a "Paste in Claude"
reminder until you do, and carries a light and dark toggle that follows your
system.

## CLI

| command | what it does |
| --- | --- |
| `init [--port N] [--force]` | project setup (non-destructive, idempotent) |
| `wait [queueDir] [--timeout M]` | *optional*: block until a selection lands, so an agent picks edits up without you pasting |
| `serve --app <origin> [--port 3850] [--queue dir]` | standalone overlay + endpoint server for non-Vite apps |
| `overlay-path` | absolute path of the overlay, for manual injection into any page |
| `skill-path` | where the bundled skill lives |

## Plugin options

`designMode({ queueDir, allowedHosts, stamp, tokens })`. `tokens` maps
families (`color`, `fontFamily`, `fontWeight`, `fontSize`, `lineHeight`,
`tracking`, `radius`, `shadow`, `spacing`) to your own custom-property
patterns when naming conventions and value types are not enough.

## Security

Submitting copies a prompt to your clipboard, so the normal path needs nothing
running and nothing listening. A copy of each payload is also written to a
per-project queue outside your repo
(`~/.claude-design-mode/<project>-<hash>/queue`), never into your working tree.
Run `wait` if you would rather an agent pick edits up without pasting; the
button then says "Send" instead of "Copy", so the page never claims a delivery
that did not happen.

Dev-serve only (never in builds, never under Vitest). The selection endpoint
requires a per-boot token in a custom header, an allowed Origin, and a local
Host; constant-time comparison, JSON only, 512KB cap. Page content in payloads
is labeled untrusted and the skill never treats it as instructions. The token
rotates on every dev-server restart; if the page stops delivering, reload it.

## Uninstall

Remove the plugin line from your Vite config, `npm rm claude-design-mode`, and
delete `.claude/skills/design-mode/` and `~/.claude-design-mode/`. Nothing else
is touched.

Full docs and source: https://github.com/pokefang/design-mode
