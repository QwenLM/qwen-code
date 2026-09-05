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
- Prioritize the normal model-to-SDK-to-Chrome workflow in pre-merge reviews.
  Uncommon shared-control scenarios are follow-up work, not initial blockers.

## Codex reference behavior

The comparison below records behavior observed in Codex Browser build
`26.803.41515`. It is a reference for later evaluation, not a public or stable
Codex API contract, and it does not prescribe a Qwen implementation.

The focus labels mean:

- **Primary:** materially affects browser-task reliability or model efficiency
  and deserves early evaluation.
- **Secondary:** useful product behavior, but not required to validate the core
  Browser Use loop.
- **Reference:** important to understand, but intentionally outside the current
  product scope.

### Runtime and SDK model

| Area                    | Codex behavior                                                                                                                                                                                      | PR1-PR3 status                                                                                   | Focus       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------- |
| Programmatic runtime    | Model-written JavaScript runs in a persistent Node kernel and calls a domain Browser SDK. Live bindings, functions, and tab handles survive across cells until the kernel resets.                   | Uses the same persistent-code model.                                                             | Secondary   |
| Trusted client boundary | The model cell is untrusted. A hash-allowlisted `browser-client` receives privileged Node REPL capabilities such as the native pipe, telemetry, approvals, response metadata, and after-code hooks. | The Browser SDK is loaded as an extension package without an equivalent trusted-module boundary. | Reference   |
| Browser discovery       | One SDK discovers IAB, extension, and CDP backends and selects them by exact family, default preference, or target URL. Browser and tab bindings remain tied to their originating backend.          | Exposes the Chrome extension backend only.                                                       | **Primary** |
| Effective API           | API members, documentation, and browser/tab capabilities are derived from the selected backend's support overrides. Unsupported members can be absent instead of failing only after invocation.     | Exposes a static Chrome-oriented API and documentation surface.                                  | **Primary** |
| Command boundary        | A JavaScript cell may compose many operations, but every browser primitive is still validated, authorized, timed, and dispatched independently.                                                     | Also dispatches individual primitives rather than treating a cell as one browser transaction.    | Secondary   |

### Model-facing browser behavior

| Area                       | Codex behavior                                                                                                                                                                                                                                       | PR1-PR3 status                                                                                    | Focus       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------- |
| Three action surfaces      | `tab.playwright` provides semantic locators and snapshots, `tab.dom_cua` acts on node IDs from a filtered visible-DOM snapshot, and `tab.cua` acts on viewport coordinates. They are distinct model-facing positioning strategies over the same tab. | Provides the same three public action families.                                                   | Secondary   |
| Page evaluation            | Playwright-style `evaluate` runs in a read-only isolated world with bounded results; page mutation is expected to use explicit browser actions. Raw CDP is a separate optional capability.                                                           | Provides Playwright evaluation without the same read-only isolation contract.                     | Reference   |
| Tab discovery and claiming | `openTabs()` returns fresh opaque claim handles plus visible metadata. Explicit tab mentions are correlated with `providerTabId`, title, and URL before claiming.                                                                                    | Supports discovery and claiming, without product-level tab-mention correlation.                   | **Primary** |
| Tab disposition            | Agent-created tabs are temporary by default; claimed tabs are released by default. Deliverable and handoff marks alter end-of-turn disposition, and marks apply only to the current turn.                                                            | Provides explicit finalization and equivalent tab dispositions.                                   | **Primary** |
| Recovery model             | A stale tab invalidates only that tab binding. An explicit browser-disconnected error invalidates the browser binding and requires a fresh browser plus fresh tabs and documentation.                                                                | Distinguishes stale-tab and stale-session errors, with a single backend/session.                  | **Primary** |
| Common interaction edges   | Dialogs, file choosers, downloads, screenshot coordinates, nested frames, navigation waits, and trusted pointer/keyboard input are part of the normal SDK surface.                                                                                   | Covers these core interaction paths.                                                              | Secondary   |
| Optional capabilities      | Browser or tab capabilities can add viewport, visibility, page assets, WebMCP, browser authentication, bot detection, or approved raw CDP without making them universal SDK methods.                                                                 | Does not yet expose a general capability collection.                                              | Secondary   |
| Additional APIs            | The manifest also describes clipboard access, content export, history, page-asset export, and developer-oriented inspection. Availability varies by backend and policy.                                                                              | Includes selected APIs such as history and console logs, not the complete Codex optional surface. | Reference   |

### Observation and lifecycle

| Area                   | Codex behavior                                                                                                                                                                                                                                                                                                                                                        | PR1-PR3 status                                                                                                 | Focus       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------- |
| Explicit observation   | Model code explicitly requests the cheapest useful state: a fresh snapshot for locator ground truth, a screenshot for visual judgment, or a narrow text/URL read. Results are filtered in the kernel before being returned.                                                                                                                                           | Supports explicit snapshots, screenshots, and focused reads.                                                   | Secondary   |
| After-code observation | `browser-client` records successful browser commands and runs an after-submitted-code hook once the whole cell finishes. It can contribute backend/browser identity, open tabs, a sanitized current URL, a screenshot, WebMCP calls, and page/session notifications through response metadata or content notifications rather than ordinary JavaScript return values. | Has no equivalent automatic post-cell observation channel.                                                     | **Primary** |
| Turn identity          | Browser requests carry Codex session and turn identity. The client retains the last live identity only for continued requests when turn metadata is temporarily unavailable.                                                                                                                                                                                          | Supports one active Browser Use session and does not associate requests with a model turn.                     | **Primary** |
| Turn-ended cleanup     | In addition to explicit tab finalization, the client watches Codex turn completion and abort records and notifies the backend that the turn ended. Cleanup therefore does not depend only on the model remembering a final SDK call.                                                                                                                                  | Explicit finalization and runtime shutdown are the current cleanup boundaries.                                 | **Primary** |
| Interruption behavior  | Extension/user interruption is surfaced as a browser-control interruption rather than raw transport terminology. Kernel reset, backend disconnect, stale tab, and normal tab cleanup are treated as different recovery cases.                                                                                                                                         | Has stable runtime errors for several stale and conflict cases, but no full turn-aware interruption lifecycle. | **Primary** |

The most important Codex behaviors to evaluate further are therefore:

1. backend-adaptive API and capability discovery;
2. exact tab/session/turn identity across discovery, claiming, and cleanup;
3. automatic after-code observation without changing normal SDK return values;
4. cleanup triggered by completed, failed, or interrupted turns independently
   of model behavior; and
5. recovery rules that distinguish a stale tab, a stale browser session, and a
   lost Node kernel binding.

## Priority 0: product boundaries

| Area                 | Work                                                                                                                                                                          | Completion signal                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Turn lifecycle       | Define cleanup behavior for completion, cancellation, and failure so it does not depend only on the model calling `finalize()`.                                               | Normal completion and ESC/error interruption clean up disposable tabs even when the model omits `finalize()`.   |
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

Manual or external closure of JavaScript dialogs outside the SDK is deferred.
The pinned Playwright version does not synchronize its dialog bookkeeping from
Chrome's dialog-closed event. The initial release supports SDK-mediated
accept/dismiss; seamless human/model shared control is not guaranteed, and no
Playwright patch is included for this edge case.

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
