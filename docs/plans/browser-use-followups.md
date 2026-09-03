# Browser Use Follow-up Plan

## Goal

Track work intentionally left out of the initial Browser Use stack. Each area
should land as a focused follow-up PR rather than expanding the core,
Chrome-relay, or product-integration PRs.

## Principles

- Keep Node REPL generic and free of browser-specific scheduling.
- Keep Playwright as the browser automation engine and Native Messaging as the
  Chrome-extension transport.
- Do not introduce a Browser Broker unless the multi-session design proves it
  necessary.
- Put product enablement in Qwen Code. The Chrome side panel does not manage
  Browser Use or History permissions.
- Preserve the current single-session behavior until a multi-session path is
  verified end to end.

## Priority 0: product boundaries

| Area                 | Work                                                                                                                                                                          | Completion signal                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Turn lifecycle       | Add a Qwen-owned turn hook that finalizes Browser Use after completion, cancellation, or failure without adding browser-specific scheduling to Node REPL.                     | Normal completion and ESC/error interruption clean up disposable tabs even when the model omits `finalize()`.   |
| Multiple sessions    | Define session identity and tab ownership across concurrent Qwen sessions. Isolate routing, cleanup, finalization, and reconnect behavior per session.                        | Two concurrent sessions can control separate tabs; stopping either session affects only its own tabs.           |
| Product opt-in       | Make Browser Use an optional Qwen Code capability that the user explicitly enables. Do not add a side-panel toggle.                                                           | A disabled Qwen session never initializes the Browser SDK or connects to the browser extension.                 |
| Local authentication | Replace the public fixed socket identity with a per-installation or per-session capability and keep local socket access private to the user.                                  | An unrelated same-user process cannot impersonate the Browser Use backend or replace an active connection.      |
| History permission   | Move Chrome History to `optional_permissions` and request or revoke it through a product-owned flow outside the side panel. Browser control must work without History access. | History calls fail clearly without a grant and work after a grant; all other Browser Use APIs remain available. |
| Windows support      | Package and register a Windows-compatible Native Messaging host with idempotent install, status, and uninstall behavior.                                                      | A packaged Qwen extension completes the managed Chrome preflight on Windows.                                    |

## Priority 1: product integration

| Area                   | Work                                                                                                                                              | Completion signal                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Existing `/cdp` bridge | Decide whether to merge or retire the existing `qwen serve` CDP bridge, and prevent the two paths from competing for a tab's debugger attachment. | Only one documented ownership path can attach to a tab at a time, with a clear error for conflicts. |
| Tab mentions           | Connect explicit composer tab mentions to Browser Use and define the model-visible correlation role of `providerTabId`.                           | A mentioned tab can be claimed without ambiguous title or URL matching.                             |
| Capability discovery   | Expose browser and tab capabilities, including viewport, page assets, and richer browser metadata, only where the model needs to branch on them.  | The SDK can describe supported operations without transport-specific probing.                       |
| Multiple backends      | Define selection and routing beyond the current Chrome extension backend.                                                                         | Backend choice is explicit and one backend cannot receive another backend's tab handles.            |

## Priority 2: optional model APIs

| Area                 | Work                                                                                                                   | Completion signal                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| HAR export           | Add bounded network recording only when a product workflow requires it.                                                | Recording has explicit start, stop, size limits, and a model-usable result.                                          |
| Clipboard            | Add clipboard APIs with a product permission boundary.                                                                 | Reads and writes require the intended user authorization and have deterministic SDK results.                         |
| Evaluation isolation | Evaluate Codex-style read-only page execution and dynamic removal of APIs that are unavailable in the current context. | Read-only evaluation cannot mutate the page, and unsupported APIs are absent or fail with a stable capability error. |

## Priority 3: runtime maintenance

| Area                     | Work                                                                                                                                              | Completion signal                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Discovery concurrency    | Define whether overlapping `openTabs()` results remain claimable, then make discovery grants follow that rule without weakening tab revalidation. | Concurrent discovery and claim calls have deterministic tests and cannot invalidate a returned result unexpectedly. |
| Snapshot truncation      | Preserve a useful prefix when a single accessibility-snapshot line exceeds the text budget.                                                       | Oversized single-line snapshots return bounded content plus a truncation marker.                                    |
| Runtime dispatch cleanup | Remove duplicate tab lookup and validation only when doing so preserves selected-tab and stale-session error behavior.                            | Each command resolves its tab once, with unchanged public errors and selection semantics.                           |
| Relay resource bounds    | Bound incomplete Native Messaging chunk sets and pre-connection queues by count and lifetime, with explicit overflow behavior.                    | Abandoned chunks and requests cannot accumulate indefinitely, and overflow fails deterministically.                 |

## Delivery

Priority indicates product importance, not a requirement to combine rows into
one PR. Every implementation PR should update this plan by removing or
narrowing the completed row and include focused unit tests plus the relevant
real-Chrome acceptance path.
