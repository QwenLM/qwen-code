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
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.4
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
type WindowTarget = { pid: number; windowId: number };
type ElementTarget = {
  pid: number;
  windowId?: number;
  elementToken: string;
};
type CoordinateTarget = WindowTarget & { x: number; y: number };
type PointOrElementTarget = CoordinateTarget | ElementTarget;
type ExactActionTarget = WindowTarget | ElementTarget;
type DeliveryOptions = { deliveryMode?: DeliveryMode };

type ComputerUse = {
  click: (
    args: PointOrElementTarget &
      DeliveryOptions & { button?: MouseButton; count?: number },
  ) => Promise<object>;
  doubleClick: (
    args: PointOrElementTarget & DeliveryOptions,
  ) => Promise<object>;
  rightClick: (
    args: PointOrElementTarget & DeliveryOptions & { modifier?: string[] },
  ) => Promise<object>;
  drag: (
    args: WindowTarget &
      DeliveryOptions & {
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
      },
  ) => Promise<object>;
  observeWindow: (
    args: WindowTarget & { disableDiff?: boolean; includeScreenshot?: boolean },
  ) => Promise<WindowObservation>;
  listApps: () => Promise<Array<App>>;
  listWindows: (args: { pid: number }) => Promise<Array<Window>>;
  performSecondaryAction: (
    args: ElementTarget & { action: string },
  ) => Promise<object>;
  pressKey: (
    args: ExactActionTarget &
      DeliveryOptions & { key: string; modifiers?: string[] },
  ) => Promise<object>;
  hotkey: (
    args: ExactActionTarget & DeliveryOptions & { keys: string[] },
  ) => Promise<object>;
  scroll: (
    args: PointOrElementTarget &
      DeliveryOptions & { direction: Direction; amount?: number },
  ) => Promise<object>;
  setValue: (args: ElementTarget & { value: string }) => Promise<object>;
  typeText: (
    args: ExactActionTarget & DeliveryOptions & { text: string },
  ) => Promise<object>;
  close: () => Promise<void>;
};

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

type WindowObservation = {
  pid: number;
  windowId: number;
  mode: 'full' | 'diff' | 'no_change';
  resyncReason?: string;
  text: string;
  elements: Array<Element>;
  screenshot?: Screenshot;
};

type Element = {
  element_token?: string;
  role?: string;
  label?: string;
  automation_id?: string;
  value?: unknown;
  actions?: string[];
};

type Screenshot = {
  images: Array<{ mimeType: string; dataBase64: string }>;
};

type Direction = 'up' | 'down' | 'left' | 'right';
type MouseButton = 'left' | 'right' | 'middle';
type DeliveryMode = 'background' | 'foreground';
```

## Workflow

### 1. Initialize

Start by getting the state for the app and window you want to use. When the task
names an app, filter for that name directly:

```js
var apps = await computer.listApps();
var matches = apps.filter(
  (app) => app.name === 'Target App' || app.bundle_id === 'com.example.target',
);
nodeRepl.write(JSON.stringify(matches));

var windows = await computer.listWindows({ pid: matches[0].pid });
var target = { pid: matches[0].pid, windowId: windows[0].window_id };
var state = await computer.observeWindow(target);
nodeRepl.write(state.text); // This will return the accessibility tree
```

If you cannot identify an app from the task, prior context, or builtin apps,
start by discovering the available apps:

```js
var apps = await computer.listApps();
nodeRepl.write(JSON.stringify(apps));
```

After performing one or more UI actions, call `observeWindow(...)` before
deciding what to do next. This keeps you in the current UI state. Read the
current actionable `element_token` values from `state.elements`; tokens for
unchanged elements remain valid across `diff` and `no_change` observations.

For token efficiency, when appropriate, the accessibility tree will be returned
as a diff from the most previous accessibility tree, listing only the elements
that were removed, added, or changed. Prefer this default diff output; pass
`disableDiff: true` only when you need a fresh full accessibility tree. If you
disregard the text from a previous call to `observeWindow`, such as when you only
emit the screenshot, get the full tree next time you inspect AX text.
`state.elements` remains the current full actionable element list when
`state.text` is a diff or reports no change.

### 2. Actions using app

Perform one or more actions, and then fetch the latest state:

```js
await computer.click({ pid: target.pid, elementToken });
await computer.setValue({ pid: target.pid, elementToken, value: 'openai.com' });
await computer.pressKey({ ...target, key: 'Enter' });
await computer.typeText({ ...target, text: 'hello' });
await computer.scroll({
  pid: target.pid,
  elementToken,
  direction: 'down',
  amount: 1,
});
await computer.performSecondaryAction({
  pid: target.pid,
  elementToken,
  action: 'Show Menu',
});
nodeRepl.write((await computer.observeWindow(target)).text);
```

Notes:

- Prefer `element_token`-based actions over coordinate actions. If AX actions or AX text are unavailable or behave unexpectedly, switch to screenshots, coordinate clicks, and key presses.
- `doubleClick` and `rightClick` invoke their dedicated SDK actions; `rightClick` also accepts optional modifiers.
- If the UI is not behaving as expected, try fetching the latest `observeWindow(...)` state to make sure you have the latest context.
- Prefer using accessibility text over screenshots for efficiency, but if the interface is not fully working or not providing enough context, make sure to fetch a screenshot to get more context. The accessibility interface may be incomplete in some applications, so a screenshot helps fully understand what is going on.
- `performSecondaryAction` invokes an accessibility action that an element exposes besides a normal click, such as expanding a disclosure row, showing a menu, incrementing a control, or cancelling something. It requires an action actually exposed for that element in the accessibility text. Do not guess action names.
- `pressKey` presses one key and accepts optional modifiers; `hotkey` sends a key combination such as `{ keys: ['ctrl', 'c'] }`. Single-key examples include `"a"`, `"Enter"`, `"Tab"`, and `"Up"`.
- Take care when passing strings containing `\n` or `\r` to `typeText`, as it simulates pressing the return key. Many apps with message composers or forms will respond by sending the message or submitting the form rather than inserting a newline.
- The SDK targets an exact PID and window ID. If an action opens a dialog, menu, or new window, call `listWindows({ pid })` again and select the current window before continuing.

## Reading screenshots

Request a screenshot with the observation, read its accessibility text, and
emit each returned image:

`includeScreenshot: true` is the parameter that requests a screenshot.

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

When all Computer Use work is complete:

```js
await computer.close();
globalThis.computer = undefined;
```

Reset the Node REPL only when no other persistent state is needed.
