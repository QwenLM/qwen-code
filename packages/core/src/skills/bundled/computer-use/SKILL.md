---
name: computer-use
description: Control local desktop applications through Computer Use for tasks that require reading or operating app UI. Prefer purpose-built connectors, APIs, or CLIs when available.
---

## `node_repl` + `@qwen-code/cua-sdk` (Computer Use)

- Use `node_repl` (JavaScript) for all Computer Use actions.
- Do not use other technologies besides `node_repl` for computer interactions
  unless specifically requested by the user. This includes AppleScript,
  `osascript`, JXA, System Events, and synthesized input.
- Prefer a dedicated plugin or skill when it can complete the task; use
  Computer Use for app interactions that are not exposed through a more
  specific interface.
- Use only the typed `ComputerUse` API. Do not use a generic SDK `callTool`,
  direct `CuaDriver` imports, or a Qwen global bridge.
- `node_repl` state persists across calls.
- Use `nodeRepl.write(...)` for text output. It takes a string, so wrap objects
  with `JSON.stringify(...)`.

## Install automatically

Run `qwen mcp list` to check whether the `node-repl` server is configured. If it
is not configured, run both commands yourself:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.0
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.0
```

Tell the user to restart Qwen Code after adding the MCP server, then stop. Do
not ask the user to copy or run the commands.

If `node_repl` is available but the SDK import fails, run the SDK installation
command yourself from the current workspace, then retry the import:

```bash
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.0
```

## Bootstrap

Import the SDK once per fresh `node_repl` kernel:

```js
globalThis.computer = await (
  await import('@qwen-code/cua-sdk/computer-use')
).ComputerUse.create();
```

## API surface

```ts
type WindowTarget = { pid: number; windowId: number };
type ElementTarget = {
  pid: number;
  windowId?: number;
  elementToken: string;
};
type CoordinateTarget = WindowTarget & { x: number; y: number };
type PointOrElementTarget = CoordinateTarget | ElementTarget;
type App = {
  name?: string;
  bundle_id?: string;
  pid?: number;
  running?: boolean;
  launch_path?: string;
};
type Window = {
  window_id: number;
  title?: string;
  is_on_screen?: boolean;
  on_current_space?: boolean;
};
type Element = {
  element_token?: string;
  role?: string;
  label?: string;
  value?: unknown;
  actions?: string[];
};

type ComputerUse = {
  listApps: () => Promise<App[]>;
  listWindows: (args?: {
    pid?: number;
    onScreenOnly?: boolean;
  }) => Promise<Window[]>;
  observeWindow: (
    args: WindowTarget & {
      baseRevisionId?: string;
      forceFull?: boolean;
      includeScreenshot?: boolean;
    },
  ) => Promise<{
    text: string;
    elements: Element[];
    revisionId?: string;
    screenshot?: { images: object[] };
  }>;
  click: (
    args: PointOrElementTarget & {
      button?: 'left' | 'right' | 'middle';
      count?: number;
    },
  ) => Promise<object>;
  doubleClick: (args: PointOrElementTarget) => Promise<object>;
  rightClick: (args: PointOrElementTarget) => Promise<object>;
  setValue: (args: ElementTarget & { value: string }) => Promise<object>;
  typeText: (args: WindowTarget & { text: string }) => Promise<object>;
  pressKey: (args: WindowTarget & { key: string }) => Promise<object>;
  hotkey: (args: WindowTarget & { keys: string[] }) => Promise<object>;
  scroll: (
    args: PointOrElementTarget & {
      direction: 'up' | 'down' | 'left' | 'right';
      by?: 'line' | 'page';
      amount?: number;
    },
  ) => Promise<object>;
  drag: (
    args: WindowTarget & {
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      deliveryMode?: 'background' | 'foreground';
    },
  ) => Promise<object>;
  performSecondaryAction: (
    args: ElementTarget & { action: string },
  ) => Promise<object>;
  close: () => Promise<void>;
};
```

## Workflow

### 1. Initialize

Resolve the exact running application and window named by the task. Filter
inside `node_repl`; do not print the entire application list:

```js
var apps = await computer.listApps();
var matches = apps.filter(
  (app) => app.name === 'Target App' || app.bundle_id === 'com.example.target',
);
nodeRepl.write(JSON.stringify(matches));
```

After choosing the application from returned metadata, list only its windows:

```js
var pid = matches[0].pid;
var windows = await computer.listWindows({ pid });
nodeRepl.write(JSON.stringify(windows));
```

Choose the window from returned metadata, then get its current accessibility
state:

```js
var target = { pid, windowId: windows[0].window_id };
var state = await computer.observeWindow({ ...target, forceFull: true });
nodeRepl.write(state.text);
```

Never guess a PID, window ID, coordinate, or element token. `ComputerUse`
discovers running applications but does not launch them; if necessary, start
the application from `node_repl` with ordinary Node.js process APIs, then
refresh the application and window lists.

### 2. Act and get the latest state

Choose only the action needed for the user's task. Prefer current
`element_token` values over coordinates. Pass an observed `element_token` as
the camel-case `elementToken` action field:

```js
await computer.setValue({
  ...target,
  elementToken,
  value: 'hello',
});

state = await computer.observeWindow({
  ...target,
  baseRevisionId: state.revisionId,
});
nodeRepl.write(state.text);
```

After one or more actions, always observe the exact window before deciding what
to do next. If the updated state shows the requested result, stop acting,
clean up, and answer the user. If the UI does not behave as expected, get a
fresh full state before choosing a different action.

Use a secondary action only when the current accessibility state advertises
that exact action. Prefer accessibility text for efficiency; use a screenshot
when it is incomplete or visual layout matters.

## Reading screenshots

```js
var state = await computer.observeWindow({
  ...target,
  forceFull: true,
  includeScreenshot: true,
});

for (var image of state.screenshot?.images ?? []) {
  if (image?.dataBase64 && image?.mimeType) {
    await nodeRepl.emitImage(
      `data:${image.mimeType};base64,${image.dataBase64}`,
    );
  }
}
```

## Finish

When the task is complete, close the SDK client:

```js
await computer.close();
globalThis.computer = undefined;
```

Call `node_repl_reset` when no other REPL state is needed.
