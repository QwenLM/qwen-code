# @qwen-code/cua-sdk/computer-use

Computer Use API included in `@qwen-code/cua-sdk`. It uses the typed native
SDK and works in ordinary Node.js or a persistent Node REPL.

## Platform workflows

`await computer.getPlatform()` returns `macos`, `windows`, or `linux` from the
connected driver's inventory. It does not infer the target from the CLI or Node
host and does not capture the desktop. Missing or invalid platform metadata
raises `driver_platform_unavailable`; update the driver and SDK before continuing.

The single [Computer Use Skill](./SKILL.md) routes to one platform resource:

- [macOS](./references/macos.md): App handles, compact app state and text operations.
- [Windows/Linux](./references/windows-linux.md): existing exact-window targeting.

Skill resources stay beside the entrypoint on the CLI host. Read the selected
resource relative to the Skill's displayed base directory, even when the driver
controls another machine. After changing connections, query the platform again.

## App workflow

On macOS, bind an application by name, identifier or installation path. The
handle resolves its current native AX window and owns targeting internally:

```js
import { ComputerUse } from "@qwen-code/cua-sdk/computer-use";

const computer = await ComputerUse.create();
const app = await computer.getApp("Microsoft Excel");
console.log((await app.getState()).text);
// Use an ID from the returned state.
await app.click(37);
await app.typeText("hello");
console.log((await app.getState()).text);
await computer.close();
```

`getApp()` binds identity without launching. `getState()` can open a discovered
stopped app through the native background launcher; actions never restart an app.
Ambiguous names or identifiers require a unique installation path from
`listApps()`. Different installations sharing a bundle ID have different handles.
Native selection uses the focused AX window, main window, then last AX window,
including attached sheets and the actual owning process.

App methods accept short observed IDs or screenshot coordinates, and do not
accept process IDs, window IDs, opaque tokens or delivery options.
`getState()` returns `{ app, window, mode, text, screenshot? }`. Native AX
projection preserves controls, meaningful disabled state and text, removes
redundant layout/text structure, and renders compact full/diff/no-change output.
Normal window observations include immediate menu-bar items. A selected open
menu supplies its own context, including nested and disabled commands.
Normal actions do not emit another full tree or image.

Call `getState()` after a dialog, sheet or menu opens or closes before acting
on its IDs. A process/window/session change invalidates prior IDs. Every App
observation captures a current screenshot internally so a later AX-only
diff/no-change does not discard the coordinate frame. The default return omits
that image; use `getState({ includeScreenshot: true })` when the caller needs to
inspect it.

Native code selects semantic or synthesized input after checking the target.
App clicks and keyboard input start on the native background path. When native
preflight proves that no actuator ran and recommends foreground delivery, the
App handle makes one guarded foreground attempt and restores the prior app.
Native drag and App paste select their guarded foreground route before dispatch.
Failed, partial, unverifiable and cancelled possible-dispatch actions are never replayed.
Errors request fresh observation before another action; they do not ask the
model to choose a delivery mode. Argument errors detected before native dispatch
retain their specific correction; uncertain post-dispatch failures retain the
cautious observe-before-retry message.

## macOS text operations

`app.paste(text, { format?, signal? })` pastes once into the current app window.
`format` defaults to `text`; `md` and `html` supply formatted content, and the
receiving app chooses which supplied format it accepts. The clipboard is restored
only while the transaction still owns it, preserving newer external clipboard
changes.
The App method activates the exact window only for the Command-V dispatch and
restores the previous foreground app. The exact-window `computer.paste(...)`
method retains PID-addressed background delivery.

`app.selectText(element, text, { prefix?, suffix?, selection?, signal? })` uses a
current short element ID and selects one exact, case-sensitive text match. Prefix
and suffix are optional immediately adjacent context; no match or multiple matches
fail. `selection` defaults to `text`; `cursor_before` and `cursor_after` place the
insertion point at that boundary. The element must support writable text selection.

```js
await app.selectText(37, "draft", { prefix: "Status: " });
console.log((await app.getState()).text);
// After confirming the intended selection:
await app.paste("ready");
console.log((await app.getState()).text);
```

Both methods return the native action effect. An error, cancellation or completed
dispatch does not establish what changed; observe before deciding whether to retry.
Neither method accepts delivery options. Exact-window callers can use
`computer.paste({ pid, windowId, text, format? })` or
`computer.selectText({ pid, windowId, elementToken, text, prefix?, suffix?, selection? })`.
These operations are macOS-only and reject other driver platforms before mutation.

## Exact-window SDK compatibility

The lower-level `ComputerUse` methods remain available to programmatic clients.
The bundled model Skill uses this workflow on Windows/Linux and the App workflow
on macOS. The rest of this document describes the existing exact-window contract.

## Observation revisions

Observation uses the driver's versioned
`accessibility.observation_revision.v1` capability. `ComputerUse` keeps one
revision cursor per exact `pid` and `windowId`. The first successful observation
is full; later calls automatically request a validated `diff` / `no_change`
response from the last successful observation for that surface. Different
windows are isolated, and reconnecting clears every cursor before observation
resumes.

Pass `disableDiff: true` only when a fresh complete tree is required. It maps to
the native force-full flag for that call alone, and a successful response
becomes the next automatic base. The legacy `forceFull` spelling remains a
compatibility alias; passing both names is rejected. If a base is stale, the
native driver returns a full resync and the wrapper adopts the replacement
revision. The wrapper never computes a second semantic diff.

An incomplete capture clears the cursor and receives one automatic observation
retry without disabling diffs. If that retry is still incomplete, the returned
tree is marked observation-only, `elements` is empty, and
`diagnostics.captureComplete` is false. Observe normally after the UI settles
or use the screenshot; disabling diffs does not repair capture completeness.

Drivers that do not advertise the capability keep the legacy full-snapshot
behavior; observations then report `diagnostics.revisionSupported: false`.

Revision and lineage identifiers are internal to `ComputerUse` and are not
returned on `WindowObservation`. Normal callers receive the current `mode`, an
optional `resyncReason`, AX text/elements, and an optional screenshot. Protocol
metrics live under `diagnostics`; the raw native response is not exposed.
`context` preserves native `backgroundInput`, `degraded`, `degradedReason`,
`escalation`, `windowBounds`, `screenshotScale`, `screenshotFrameValid`, and
`screenshotError` when available. Consult this context before deciding whether
pixel input or an explicit foreground request is appropriate. Coordinates for
SDK actions remain screenshot pixels; `windowBounds` describes screen points.
The native revision's `capture_complete` flag takes precedence over a legacy
root-level flag.

Treat a full response as the complete current AX state. Apply later diffs to
that state; a no-change response leaves it intact. `elements` remains the
current full actionable list for retained full, diff, and no-change responses.
While the same stable lineage is retained, tokens for unchanged elements remain
current across all three modes; only removed or replaced element tokens become
invalid.

Screenshot capture is independent from the observation revision mode.
`includeScreenshot: true` requests the image; `disableDiff: true` requests a
fresh complete AX tree. Combine them only when both outputs are independently
needed.

## Delivery defaults

Actions that support input delivery resolve their mode in this order:

1. the action's explicit `deliveryMode`;
2. `QWEN_CUA_SDK_DEFAULT_DELIVERY_MODE` (`background` or `foreground`);
3. `background`.

The resolved value is passed to the typed driver for every supported action.
Use the environment default when a whole isolated process, such as a test
worker, should consistently use foreground delivery. A per-action value still
overrides it. Invalid environment values fail facade creation, and the public
JavaScript option remains camelCase: `delivery_mode` is rejected instead of
being silently ignored.

## Usage

```js
import { ComputerUse } from "@qwen-code/cua-sdk/computer-use";

const computer = await ComputerUse.create(); // configured in-process runtime + trusted session
try {
  const apps = await computer.listApps();
  const windows = await computer.listWindows({ pid: apps[0].pid });

  const first = await computer.observeWindow({
    pid: apps[0].pid,
    windowId: windows[0].window_id,
  });
  // ... deliver first.text downstream, act on element tokens ...
  await computer.click({ pid: apps[0].pid, elementToken: first.elements[0].element_token });

  const second = await computer.observeWindow({
    pid: apps[0].pid,
    windowId: windows[0].window_id,
  });
  console.log(second.mode); // "diff" | "no_change" | "full"

  await computer.drag({
    pid: apps[0].pid,
    windowId: windows[0].window_id,
    fromX: 100,
    fromY: 100,
    toX: 300,
    toY: 100,
    deliveryMode: "foreground", // explicit last resort when background drag is unavailable
  });

  const complete = await computer.observeWindow({
    pid: apps[0].pid,
    windowId: windows[0].window_id,
    disableDiff: true,
  });
  console.log(complete.mode); // "full"
} finally {
  await computer.close();
}
```

`ComputerUse.connect({ socketPath })` instead binds the same trusted-session
surface to a caller-selected daemon. In-process use inherits the host process's
platform accessibility permissions; daemon use inherits the selected daemon's
identity and permissions.

## Tests

- `npm test` — hermetic facade tests against a fake driver handle and Skill packaging checks.
- `npm run test:e2e` — standalone high-level wrapper run against a real target;
  set `COMPUTER_USE_PID` and `COMPUTER_USE_WINDOW`. It uses an isolated
  configured runtime by default; set `COMPUTER_USE_SOCKET` only when testing a
  specific compatible daemon. Unset target variables skip the suite.
