# @qwen-code/cua-sdk/computer-use

Thin Computer Use wrapper included in the single `@qwen-code/cua-sdk` npm
package. It calls that package's typed driver API directly and does not depend
on Qwen Code, a Node REPL, or a Skill.

The wrapper exposes a small surface — application discovery, exact-window
observation, opaque element-token actions, and state verification — while
keeping raw SDK constructors and arbitrary tool dispatch out of its public API.

## Observation revisions

Observation uses the driver's versioned
`accessibility.observation_revision.v1` capability. The **caller** owns the
base-revision state: pass the `revisionId` of the last observation that was
actually consumed downstream as `baseRevisionId`, and the driver answers with a
validated `diff` / `no_change` response instead of a full tree whenever its
native identity lineage allows it. The wrapper never computes its own diff and
never guesses which revision was delivered.

Drivers that do not advertise the capability keep the legacy full-snapshot
behavior; observations then report `revisionSupported: false`.

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
    baseRevisionId: first.revisionId, // caller-owned base
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
