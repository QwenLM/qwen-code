# @qwen-code/cua-sdk/computer-use

Thin Computer Use wrapper included in the single `@qwen-code/cua-sdk` npm
package. It calls that package's typed driver API directly and does not depend
on Qwen Code, a Node REPL, or a Skill.

The wrapper exposes a small surface — application discovery, exact-window
observation, opaque element-token actions, and state verification — while
keeping raw SDK constructors and arbitrary tool dispatch out of its public API.

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

- `npm test` — hermetic unit tests against a fake driver handle.
- `npm run test:e2e` — standalone high-level wrapper run against a real target;
  set `COMPUTER_USE_PID` and `COMPUTER_USE_WINDOW`. It uses an isolated
  configured runtime by default; set `COMPUTER_USE_SOCKET` only when testing a
  specific compatible daemon. Unset target variables skip the suite.
