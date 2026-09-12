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

## Bootstrap

If `node_repl` is unavailable, run:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.3
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.6
```

Tell the user to restart Qwen Code, then stop. If only the SDK import is missing,
run the second command and retry.

Import the `ComputerUse` API directly once per fresh `node_repl` session:

```js
globalThis.computer = await (
  await import('@qwen-code/cua-sdk/computer-use')
).ComputerUse.create();
```

## API surface

```ts
type Point = number | { x: number; y: number };
type ComputerUse = {
  getApp: (nameOrIdentifierOrPath: string) => Promise<App>;
  listApps: () => Promise<
    Array<{ name?: string; bundle_id?: string; launch_path?: string }>
  >;
  close: () => Promise<void>;
};
type App = {
  getState: (options?: {
    disableDiff?: boolean;
    includeScreenshot?: boolean;
  }) => Promise<State>;
  click: (
    point: Point,
    options?: { button?: 'left' | 'right' | 'middle'; count?: number },
  ) => Promise<object>;
  doubleClick: (point: Point) => Promise<object>;
  rightClick: (
    point: Point,
    options?: { modifier?: string[] },
  ) => Promise<object>;
  setValue: (element: number, value: string) => Promise<object>;
  performSecondaryAction: (element: number, action: string) => Promise<object>;
  typeText: (text: string) => Promise<object>;
  pressKey: (
    key: string,
    options?: { modifiers?: string[] },
  ) => Promise<object>;
  hotkey: (keys: string[]) => Promise<object>;
  scroll: (
    point: Point,
    options: { direction: 'up' | 'down' | 'left' | 'right'; amount?: number },
  ) => Promise<object>;
  drag: (options: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  }) => Promise<object>;
};
type State = {
  app: string;
  window: string;
  mode: 'full' | 'diff' | 'no_change';
  text: string;
  screenshot?: { images: Array<{ mimeType: string; dataBase64: string }> };
};
```

## Workflow

### 1. Initialize

On macOS, bind the app named by the task, then read its state.
`getApp()` binds identity; `getState()` can open a discovered stopped app. Combine these
steps in one Node REPL call:

```js
var app = await computer.getApp('Microsoft Excel');
nodeRepl.write((await app.getState()).text);
```

The app handle tracks its current window and dialog. Read the returned window
title to confirm the intended document. If the app is unknown or its name is
ambiguous, discover applications with `computer.listApps()` and use a matching
application identifier or path.

AX text uses short numeric IDs, such as `[37] TextField "Name"`. Use IDs from
the current observation for element actions. IDs can change when the app's
window or session changes. Disabled and static-text rows are observation-only.

For token efficiency, the accessibility tree will be returned
as a diff when appropriate. Prefer this default diff output. A full state
replaces the previous state; a diff updates it; no-change preserves it. If you
need a full replacement, use `disableDiff: true` only when the previous state
is unavailable or no longer useful. Do not disregard the text and then assume
that a subsequent diff will reproduce the information you skipped.

### 2. Actions using app

After performing one or more UI actions, call `app.getState()` before deciding
what to do next. Batch actions whose target remains the same, then print only
the state needed for the next decision:

```js
await app.click(37);
await app.hotkey(['super', 'a']);
await app.typeText('hello');
await app.pressKey('Return');
nodeRepl.write((await app.getState()).text);
```

Use the actual ID from your observation; `37` is only an example.

- Prefer element IDs to coordinates. `setValue(id, value)` changes a writable control, and `performSecondaryAction(id, action)` invokes a secondary action listed for that element. Use an observed action name rather than guessing.
- When an action opens or closes a dialog, sheet or menu, end the batch and call `app.getState()` to read the new window and IDs before continuing.
- An action error can occur after the UI already changed. Read state before deciding whether to retry. Partial, unconfirmed or cancelled actions must not be blindly repeated.
- Coordinate actions use pixels in the screenshot returned for this app, with `(0, 0)` at its top-left. Request a fresh screenshot after a window change. Do not infer coordinates from another window or desktop screenshot.
- `pressKey` sends one key, optionally with modifiers. `hotkey` sends a combination such as `['super', 's']`. Use the platform's appropriate shortcut.
- Literal `\n` or `\r` in `typeText` sends Return. In a composer or form this may submit rather than insert a newline.
- If AX is incomplete or does not explain the interface, request a screenshot and inspect it. Incomplete observations do not authorize element actions.

## Reading screenshots

`includeScreenshot: true` is the parameter that requests a screenshot.
Image capture is independent of whether AX returns full state or a diff.

```js
var state = await app.getState({ includeScreenshot: true });
nodeRepl.write(state.text);
for (const image of state.screenshot?.images ?? []) {
  await nodeRepl.emitImage(`data:${image.mimeType};base64,${image.dataBase64}`);
}
```

When all Computer Use work is complete:

```js
await computer.close();
globalThis.computer = undefined;
```

Reset the Node REPL only when no other persistent state is needed.
