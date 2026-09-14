---
name: computer-use
description: Control local desktop applications through Computer Use for tasks that require reading or operating app UI. Prefer purpose-built connectors, APIs, or CLIs when available.
---

## node_repl + @qwen-code/cua-sdk (Computer Use)

- Use `node_repl` (JavaScript) for all Computer Use actions.
- Do not use other technologies besides `node_repl` for computer interactions, unless specifically requested by the user (e.g. AppleScript, `osascript`, JXA, System Events, synthesized input).
- Prefer a dedicated plugin or skill when it can complete the task; use Computer Use for app interactions that are not exposed through a more specific interface.
- `node_repl` state is persistent across calls.
- For text output, use `nodeRepl.write(...)`. It takes a string; use `JSON.stringify(...)` only for textual metadata. For an observation, write its `.text` and emit its screenshots as images; do not stringify an observation or driver result containing image bytes.
- Omit `yield_time_ms` for ordinary UI calls to use the default 10-second wait. A shorter yield does not speed up the action and can add a `node_repl_wait` round. Use a shorter yield only when you need control back before completion; if a cell is still running, collect its result with `node_repl_wait` before issuing dependent actions.

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
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.5
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.8
```

Tell the user to restart Qwen Code, then stop. If only the SDK import is missing,
run the second command and retry.

Reuse an existing `computer` connected to the intended desktop. Otherwise import
the `ComputerUse` API once per fresh `node_repl` session. Combine initialization
and connected-platform discovery in one call. Linux uses the complete workflow below
in this file. macOS and Windows also read their selected resource in that call;
set `skillBase` to the absolute Skill base directory shown by the skill loader
or the file you just read:

```js
globalThis.computer = await (
  await import('@qwen-code/cua-sdk/computer-use')
).ComputerUse.create();
var platform = await computer.getPlatform();
var reference = {
  macos: 'macos.md',
  windows: 'windows-linux.md',
}[platform];
if (!reference && platform !== 'linux') {
  throw new Error('Unsupported connected platform');
}
nodeRepl.write(`Connected platform: ${platform}`);
if (reference) {
  var skillBase = '/absolute/path/to/computer-use';
  nodeRepl.write(
    await (
      await import('node:fs/promises')
    ).readFile(`${skillBase}/references/${reference}`, 'utf8'),
  );
}
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

For Linux, use the workflow below directly; no additional skill file is needed.
For macOS or Windows, initialization reads exactly one resource. If filesystem
imports are unavailable, use the following fallback before any UI work.
Read exactly one resource with `read_file`, resolving its absolute path from the
Skill base directory shown above:

- `macos`: read `references/macos.md` for the App workflow and text operations.
- `windows`: read `references/windows-linux.md` for the exact-window workflow.

On macOS and Windows, read the selected resource before taking actions. Once it
has been printed in the initialization result, do not read it again. After
changing the connected desktop, query its platform again and follow that
platform’s workflow. Resource files remain on the machine hosting this Skill;
do not look for them on the controlled desktop.

## Linux Computer Use

Use this workflow when `computer.getPlatform()` returns `linux`. The bootstrap
above has already initialized `computer`. This workflow is complete in this
`computer-use/SKILL.md` file.

### Targeting and input

Keep the observed process ID, window ID and element tokens. Input delivery is
managed by the runtime: it chooses a semantic action where available and prepares
the exact window's focus when native keyboard or pointer input requires it.

```ts
type WindowTarget = { pid: number; windowId: number };
type ElementTarget = { pid: number; windowId?: number; elementToken: string };
type CoordinateTarget = WindowTarget & { x: number; y: number };
type PointOrElementTarget = CoordinateTarget | ElementTarget;
type ExactActionTarget = WindowTarget | ElementTarget;

type ComputerUse = {
  listApps(): Promise<
    Array<{
      name?: string;
      bundle_id?: string;
      pid?: number;
      running?: boolean;
    }>
  >;
  listWindows(args: { pid: number; onScreenOnly?: boolean }): Promise<
    Array<{
      window_id: number;
      title?: string;
      is_on_screen?: boolean;
    }>
  >;
  observeWindow(
    args: WindowTarget & {
      disableDiff?: boolean;
      includeScreenshot?: boolean;
      maxTextChars?: number;
    },
  ): Promise<WindowObservation>;
  click(
    args: PointOrElementTarget & {
      button?: 'left' | 'right' | 'middle';
      count?: number;
    },
  ): Promise<object>;
  doubleClick(args: PointOrElementTarget): Promise<object>;
  rightClick(
    args: PointOrElementTarget & { modifier?: string[] },
  ): Promise<object>;
  drag(
    args: WindowTarget & {
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
    },
  ): Promise<object>;
  scroll(
    args: PointOrElementTarget & {
      direction: 'up' | 'down' | 'left' | 'right';
      amount?: number;
    },
  ): Promise<object>;
  pressKey(
    args: ExactActionTarget & { key: string; modifiers?: string[] },
  ): Promise<object>;
  hotkey(args: ExactActionTarget & { keys: string[] }): Promise<object>;
  typeText(args: ExactActionTarget & { text: string }): Promise<object>;
  setValue(args: ElementTarget & { value: string }): Promise<object>;
  performSecondaryAction(
    args: ElementTarget & { action: string },
  ): Promise<object>;
  close(): Promise<void>;
};

type WindowObservation = {
  pid: number;
  windowId: number;
  mode: 'full' | 'diff' | 'no_change';
  text: string;
  elements: Array<{
    element_token?: string;
    role?: string;
    label?: string;
    value?: unknown;
    actions?: string[];
  }>;
  screenshot?: { images: Array<{ mimeType: string; dataBase64: string }> };
};
```

### Discover and observe

Filter the app named by the task, then select its intended window from the
observed titles. If either is ambiguous, print the candidates before choosing.
Do not assume the first window is the task window.

```js
var apps = await computer.listApps();
nodeRepl.write(JSON.stringify(apps.filter((app) => app.name === 'Target App')));
// Use the matching app's observed PID.
var windows = await computer.listWindows({
  pid: targetPid,
  onScreenOnly: true,
});
nodeRepl.write(JSON.stringify(windows));
// Use the selected window's observed ID.
var target = { pid: targetPid, windowId: selectedWindowId };
var state = await computer.observeWindow(target);
nodeRepl.write(state.text);
```

Combine discovery, selection and observation in one cell when the target is
unambiguous. If the app is unknown, print `await computer.listApps()` first.
Reuse `computer` and the selected target across calls.

Observations default to text diffs. `state.elements` is the full current
captured element list even when `.text` reports a diff or no change. Use tokens
from that list; unchanged tokens remain usable across observations. After a
capture read failure, use only tokens issued by the latest observation.

Text rows omit default enabled/unselected states and the primary click action.
`disabled` and `selected` mark non-default states; `actions` lists secondary
actions. Editable content appears separately from its label as `value`, including
an empty value after clearing a field. The element list retains all actions.

Text is limited to 12,000 characters by default. Filter the elements for controls
you need, or request `disableDiff: true` with a larger `maxTextChars` (minimum
512). An omitted row does not prove absence. If you discarded earlier text,
request a full tree the next time you read accessibility text.

### Act and verify

Prefer current element tokens. Use screenshot coordinates for controls whose
accessibility actions or text are unavailable. Coordinates are pixels in the
PNG for that exact window, measured from its top-left corner. Accessibility
`frame` values are screen-space logical points; do not use them as PNG pixels.

Batch only actions whose target remains the same, then observe:

```js
await computer.click({ pid: target.pid, elementToken });
await computer.typeText({ ...target, text: 'hello' });
nodeRepl.write((await computer.observeWindow(target)).text);
```

When the controls and next actions are already known, combine the actions and
saving in the same cell, then observe. A new observation is a decision boundary;
do not split a known sequence into one call per action.

End the batch when opening a dialog or menu. For a dialog, list windows and
observe the matching window before typing. For a menu in the same window,
refresh its observation and use current menu tokens. Never guess a window ID.

The runtime may retry focus preparation before sending input. An action error,
cancellation, `suspected_noop` or `unverifiable` result does not establish that
nothing happened. Observe the current windows and state before deciding to
repeat an action. Do not blindly replay the previous batch or token.

`pressKey` accepts one key and optional modifiers; `hotkey` accepts a combination
such as `{ ...target, keys: ['ctrl', 'c'] }`. `performSecondaryAction` requires an
action actually exposed by that element. Newlines in `typeText` can submit forms
or send messages instead of inserting a line break.

### Read screenshots

Request the screenshot explicitly, print only the observation's text, and emit
each image:

```js
var state = await computer.observeWindow({
  ...target,
  includeScreenshot: true,
});
nodeRepl.write(state.text);
for (const image of state.screenshot?.images ?? []) {
  await nodeRepl.emitImage(`data:${image.mimeType};base64,${image.dataBase64}`);
}
```

Do not stringify the whole observation or a raw driver result containing image
bytes. In outer code mode, also forward each returned image block with `image()`
as shown in the shared entrypoint, including images from `node_repl_wait`.

Include `await computer.close()` and clearing `globalThis.computer` at the end
of the cell that emits final verification. Inspect that result before reporting
success; reconnect if it reveals unfinished work. Avoid a separate cleanup-only
call. Reset the REPL only when no other persistent state is needed.
