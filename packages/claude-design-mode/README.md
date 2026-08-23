# claude-design-mode

Click an element in your running app, describe the change or edit it in a
Figma-style sidebar, and Claude Code edits the exact source line that rendered
it. Inspector overlay + Vite plugin (or a standalone server for any stack) +
the Claude Code session skill + a wake watcher, in one package.

```bash
npm i -D claude-design-mode
npx claude-design-mode init
```

`init` copies the session skill into `.claude/skills/design-mode/`, writes a
`.claude/launch.json` entry for the Browser pane, ignores `.design-mode/`, and
prints the one line to add to your Vite config:

```js
import designMode from 'claude-design-mode/vite'
export default defineConfig({ plugins: [designMode(), react()] }) // designMode() first
```

Not on Vite? Run `npx claude-design-mode serve --app http://localhost:3000`
next to your dev server and add
`<script src="http://localhost:3850/__design-mode/boot.js"></script>` in
development.

Then, in a Claude Code session in the project, say "start design mode". In the
page, `Cmd+D` (Ctrl+D on Windows and Linux) toggles the inspector: click anything, type an instruction or
edit values (tokens are discovered from your own CSS), and "Ask Claude to
commit".

## CLI

| command | what it does |
| --- | --- |
| `init [--port N] [--force]` | project setup (non-destructive, idempotent) |
| `wait [queueDir] [--timeout M]` | block until a selection lands (the session's wake watcher) |
| `serve --app <origin> [--port 3850] [--queue dir]` | standalone overlay + endpoint server for non-Vite apps |
| `overlay-path` | absolute path of the overlay, for manual injection into any page |
| `skill-path` | where the bundled skill lives |

## Plugin options

`designMode({ queueDir, allowedHosts, stamp, tokens })`. `tokens` maps
families (`color`, `fontFamily`, `fontWeight`, `fontSize`, `lineHeight`,
`tracking`, `radius`, `shadow`, `spacing`) to your own custom-property
patterns when naming conventions and value types are not enough.

## Security

Dev-serve only. The selection endpoint requires a per-boot token in a custom
header, an allowed Origin, and a local Host; constant-time comparison, JSON
only, 512KB cap. Page content in payloads is labeled untrusted and the skill
never treats it as instructions.

Full docs and source: https://github.com/pokefang/design-mode
