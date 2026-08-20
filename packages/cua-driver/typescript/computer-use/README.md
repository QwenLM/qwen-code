# @qwen-code/computer-use

Thin Computer Use wrapper over the typed [`@trycua/cua-driver`](..) TypeScript
SDK for ordinary Node.js programs. It does not depend on Qwen Code, a Node
REPL, or a Skill.

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
import { ComputerUse } from "@qwen-code/computer-use";

const computer = await ComputerUse.connect(); // installed qwen-cua-driver daemon
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
} finally {
  await computer.close();
}
```

`ComputerUse.create()` runs the driver in-process instead (the observing
process then needs the platform accessibility permissions itself).

## Tests

- `npm test` — hermetic unit tests against a fake driver handle.
- `npm run test:integration` — standalone end-to-end run against a live
  daemon; set `COMPUTER_USE_SOCKET`, `COMPUTER_USE_PID`, and
  `COMPUTER_USE_WINDOW` first (unset variables skip the suite).
