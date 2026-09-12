# Agent View command handoff

PR 7802 exposes Agent View entry points that must be safe without the roster UI
from PR 7803. This change moves only the runtime behavior required by those
entry points.

- Initial background prompts are passed in the worker argv while dispatch still
  waits for the worker-ready event.
- A native `/background` adoption shuts down and exits the foreground runtime
  after the supervisor accepts the handoff.
- An attached worker detaches through the existing worker sideband event.
- Interactive resume rejects live managed sessions after direct or picker
  resolution.
- `agents` is a reserved command word with an explicit `list` spelling;
  ambiguous separator and boolean-assignment forms fail loudly.
- Background dispatch rejects every explicitly supplied per-invocation boolean,
  including false and negated forms that are not forwarded to the worker.
- A hibernated worker is treated like an exited worker for foreground
  `--continue` takeover.
- Resume and continue only re-attach existing startup worktrees, so their early
  exits never need to delete a worktree owned by another process.

Roster rendering, peek, answer, redraw, and general worker-control polling stay
in PR 7803.
