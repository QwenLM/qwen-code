---
name: computer-use
description: Control local desktop applications through Computer Use for tasks that require reading or operating app UI. Prefer purpose-built connectors, APIs, or CLIs when available.
---

# Computer Use with the CUA SDK

- Prefer a dedicated connector or API. Use Computer Use only for UI state or
  interactions the dedicated interface does not expose.
- Perform Computer Use through `node_repl` and the typed `ComputerUse` API.
  Do not use generic `callTool`, direct driver imports, AppleScript, JXA, or
  synthesized-input utilities.
- Observe the exact current window before acting. Prefer current element tokens
  over screenshot coordinates; use coordinates only when accessibility is
  incomplete and the screenshot provides the target.
- Treat an action result as delivery evidence, not task completion. Decide from
  fresh state and require stable postcondition evidence.

## Setup

If `node_repl` is unavailable, run these commands yourself:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.2
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.3
```

Tell the user to restart Qwen Code, then stop. If only the SDK import is
missing, run the second command and retry.

Create one persistent client per REPL kernel:

```js
globalThis.computer = await (
  await import('@qwen-code/cua-sdk/computer-use')
).ComputerUse.create();
globalThis.cuaRevisions ??= new Map();
```

## Target and observe

Use `listApps({signal:nodeRepl.signal})` and filter in JavaScript; print only
likely matches. After selecting a real PID, call
`listWindows({pid,signal:nodeRepl.signal})` and choose from returned
metadata. Never guess a PID, window ID, element token, or coordinate. If the
app is not running, start it with ordinary Node.js process APIs and refresh the
lists.

Maintain one revision cursor per window surface. The first observation has no
base; later observations use only the last revision actually consumed for that
same surface:

```js
globalThis.observeCuaWindow = async (target, options = {}) => {
  const key = `${target.pid}:${target.windowId}`;
  const state = await computer.observeWindow({
    ...target,
    ...options,
    baseRevisionId: cuaRevisions.get(key),
    signal: nodeRepl.signal,
  });
  if (state.revisionId) cuaRevisions.set(key, state.revisionId);
  return state;
};
```

Use accessibility text for efficient decisions. Request a screenshot when the
tree is incomplete, visual layout matters, or action evidence conflicts with
the tree. Emit only decision-relevant images:

```js
for (const image of state.screenshot?.images ?? []) {
  if (image?.dataBase64 && image?.mimeType) {
    await nodeRepl.emitImage(
      `data:${image.mimeType};base64,${image.dataBase64}`,
    );
  }
}
```

If the SDK explicitly reports a missing/invalid base or a stale lineage,
perform one observation with `forceFull: true`, replace that surface's cursor,
then resume the normal helper. Do not make full observations the default.

## Act and verify

Choose the narrowest action supported by current state. Pass an observed
`element_token` as `elementToken`. Use `performSecondaryAction` only when that
exact action appears in the element's current `actions` list.

Before acting, state a concrete observable postcondition. For postconditions
expressible as window or element state, use `actAndVerify` with `verifyState`:

```js
try {
  globalThis.lastCuaOutcome = await computer.actAndVerify({
    action: () =>
      computer.setValue({
        ...target,
        elementToken,
        value: expectedValue,
        signal: nodeRepl.signal,
      }),
    verify: () =>
      computer.verifyState({
        ...target,
        expect: [
          {
            element: {
              selector: { role: expectedRole, label_contains: expectedLabel },
              value_equals: expectedValue,
            },
          },
        ],
        stableSamples: 2,
        signal: nodeRepl.signal,
      }),
  });
  nodeRepl.write(JSON.stringify(lastCuaOutcome));
} catch (error) {
  nodeRepl.write(JSON.stringify(error?.details ?? { message: String(error) }));
  throw error;
}
```

`verifyState.expect` accepts one to eight AND-combined predicates:

- `{window:{exists, bounds?}}`
- `{element:{selector:{role?, label_contains?}, exists:true?,
value_equals?, enabled?, selected?}}`

Element absence is not provable. `unknown` and `stable:false` are not success.
When the postcondition is visual or unsupported, observe the exact window
again with a screenshot and inspect the fresh result before deciding. If state
is unexpected, observe again rather than repeating the action blindly.

Read every action result. `effect` is `confirmed`, `partial`, `unverifiable`,
`suspected_noop`, or `refused`; `route`, `delivery`, `evidence`, `escalation`,
and `operation` explain what actually happened. A committed operation can
still have `cancellationRequested:true`, so it still requires verification.
Follow an advertised escalation only after fresh state shows it is needed.

## Interaction details

- After navigation, dialogs, menus, or other surface changes, refresh the
  relevant window list and observe the new exact surface.
- Use returned state to determine text-field behavior; do not assume typing
  replaces existing text. Use the platform-appropriate select-all action when
  replacement is required.
- Prefer background delivery. Use `deliveryMode:'foreground'` only when the
  action result or fresh state shows the background route is unavailable or
  ineffective.
- Stop as soon as the requested postcondition is stably satisfied. Do not add
  extra cleanup actions that could undo the result.

## Finish

```js
await computer.close();
globalThis.computer = undefined;
globalThis.cuaRevisions = undefined;
globalThis.observeCuaWindow = undefined;
```

Reset the REPL only when no other persistent state is needed.
