---
name: computer-use
description: Control local desktop applications through Computer Use for tasks that require reading or operating app UI. Prefer purpose-built connectors, APIs, or CLIs when available.
---

## node_repl + @qwen-code/cua-sdk (Computer Use)

- Use `node_repl` (JavaScript) for all Computer Use actions.
- Do not use other technologies besides `node_repl` for computer interactions, unless specifically requested by the user (e.g. AppleScript, `osascript`, JXA, System Events, synthesized input).
- Prefer a dedicated plugin or skill when it can complete the task; use Computer Use for app interactions that are not exposed through a more specific interface.
- `node_repl` state is persistent across calls.
- For text output, use `nodeRepl.write(...)`. `nodeRepl.write(...)` takes a string. If you would like to read a whole object, wrap it with `JSON.stringify(...)`.

## Forwarding results in Codex code mode

When calling `node_repl` through `tools.*` inside Codex's outer `functions.exec`,
forward each returned `content` block by its type. `nodeRepl.emitImage(...)`
produces an MCP image block; the outer script must pass that block to `image()`
for the model to receive an image. Use the tool name exposed by your MCP server:

```js
const result = await tools.mcp__node_repl__node_repl({ code });
for (const block of result.content ?? []) {
  if (block.type === 'text') {
    text(block.text);
  } else if (block.type === 'image') {
    image(block);
  }
}
```

Here `code` is the JavaScript to run in the persistent Node REPL. Keep the
forwarding loop in the outer code-mode script, outside that `code` string.
Apply the same loop to `node_repl_wait` results: images may arrive only when a
running cell completes. Forward text blocks too, including running-cell IDs and
errors. Direct MCP tool calls do not need this outer forwarding loop.

Do not use `text(result)`, `text(block)`, or `JSON.stringify(result)` to forward
an MCP result containing images: this turns image base64 into text, consuming
context without showing the image. `image()` accepts one image block, not the
whole result, so do not use `image(result)` either.

## Bootstrap

If `node_repl` is unavailable, run:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.4
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.6
```

Tell the user to restart Qwen Code, then stop. If only the SDK import is missing,
run the second command and retry.

Reuse an existing `computer` connected to the intended desktop. Otherwise import
the `ComputerUse` API once per fresh `node_repl` session. Combine initialization,
connected-platform discovery and the selected resource read in one call. Set
`skillBase` to the absolute Skill base directory of this `SKILL.md`, as shown by
the skill loader or the file you just read:

```js
globalThis.computer = await (
  await import('@qwen-code/cua-sdk/computer-use')
).ComputerUse.create();
var platform = await computer.getPlatform();
var reference = {
  macos: 'macos.md',
  windows: 'windows-linux.md',
  linux: 'windows-linux.md',
}[platform];
if (!reference) throw new Error('Unsupported connected platform');
var skillBase = '/absolute/path/to/computer-use';
nodeRepl.write(`Connected platform: ${platform}`);
nodeRepl.write(
  await (
    await import('node:fs/promises')
  ).readFile(`${skillBase}/references/${reference}`, 'utf8'),
);
```

If the returned platform is `macos` and the task already identifies an
unambiguous app, append its initial observation to that same initialization
call, after printing the resource:

```js
if (platform === 'macos') {
  var app = await computer.getApp('App named by the task');
  nodeRepl.write((await app.getState()).text);
}
```

Replace the example app name with the task's app. This only binds the app and
reads its current state; `getState()` can open that app if stopped. Read both
the returned platform workflow and initial state before any editing or input.
If the app is unknown or ambiguous, omit this block and follow the selected
resource's discovery steps. Do not guess an app or use the host platform.

## Select the target platform workflow

Use this returned platform, not the CLI or Node host operating system. A connected
driver may control a different machine. If the platform cannot be determined,
resolve the reported driver/SDK error before continuing; do not guess a platform.

The initialization call above reads exactly one resource. If filesystem imports
are unavailable, use the following fallback before any UI work.
Read exactly one resource with `read_file`, resolving its absolute path from the
Skill base directory shown above:

- `macos`: read `references/macos.md` for the App workflow and text operations.
- `windows` or `linux`: read `references/windows-linux.md` for the exact-window workflow.

Read the selected resource before taking actions. Once it has been printed in the
initialization result, do not read it again. After changing the connected desktop,
query its platform again and read the matching resource. Resource files remain on
the machine hosting this Skill; do not look for them on the controlled desktop.
