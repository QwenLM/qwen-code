# Node REPL and Computer Use reliability, round 2

## Scope

This change implements only the ten agreed items below. Every implementation
iteration must check its diff against this list before continuing.

### Runtime defects

- A1: a timed out or cancelled cell must not replace the persistent Node REPL
  kernel. One active cell is manageable through start/yield, wait, and cancel.
- A2: remove the facade-wide native deadline. A native operation has one
  end-to-end cancellation lifecycle and must distinguish cancellation before
  dispatch from an action that has already committed.
- A3: one blocked Windows UIA provider must not suppress screenshot and surface
  results. UIA traversal is bounded before provider work and isolated behind a
  terminable worker boundary.
- A4: the packaged UIAccess worker is a required Windows runtime component and
  owns foreground acquisition plus input delivery as one operation.

### Model-visible guidance

- B1: Node REPL MCP instructions contain only the minimal persistent-kernel
  contract: cross-cell scope, `globalThis` versus lexical bindings, dynamic
  import, selective output, and cell/reset lifecycle.
- B2: the Computer Use skill directly migrates Codex's `API surface` and
  `Workflow` sections onto the typed CUA SDK. Section structure, prose order,
  action-batch example structure, and decision semantics stay aligned; only
  SDK-required mappings change.
- B3: after one or more UI actions, call `observeWindow(...)` before deciding
  what to do next. There is no per-action observation rule.
- B4: the full Computer Use skill is not embedded in Node REPL MCP
  instructions. The two texts have one source and one owner each.
- B5: both texts are minimum viable guidance. They contain no benchmark rules,
  scores, evaluators, historical case names, failure counts, application
  special cases, or duplicated examples. The final outbound model request is
  the delivery boundary.
- B6: the SDK maintains one revision cursor per exact surface. `disableDiff` is
  a one-shot complete-tree request and is never a persistent helper default.

## Non-goals

- Multi-cell concurrency, a background job queue, or a general scheduler.
- Persistent operation journals, crash recovery transactions, automatic action
  retry, distributed coordination, or a second general worker framework.
- A generic UIA/MSAA/vision fusion engine or new visual recognition semantics.
- Input across the UAC secure desktop or login desktop.
- Changes to JavaScript lexical semantics, automatic block wrapping, binding
  deletion, or code rewriting to hide redeclarations.
- A new native revision protocol, model-managed revision helper, or
  benchmark-specific policy.

## Implementation order

1. Reproduce and fix A1, then verify kernel PID, generation, object identity,
   binding retention, output suppression, and one-active-cell behavior.
2. Remove the TypeScript facade deadline and implement the minimal native
   operation lifecycle required by A2. Verify cancellation before dispatch,
   committed action reporting, and absence of late work.
3. Isolate and bound UIA observation for A3. Preserve screenshot, Win32 surface
   metadata, partial accessibility coverage, and degraded diagnostics.
4. Activate and route the existing packaged UIAccess worker for A4. Keep the
   public SDK and MCP endpoint unchanged.
5. Rewrite the Node REPL instruction and Computer Use skill for B1-B6. Record
   the mechanical API mapping from the canonical Codex workflow to the typed
   SDK, while keeping native revision details and state-verification helpers
   out of model guidance.
6. Run focused tests, build/typecheck, protocol E2E, Windows interactive tests,
   AP-container-equivalent bootstrap, and representative prior-failure jobs.

## Iteration gates

After each fix:

1. Read the complete diff against A1-A4 and B1-B6.
2. Remove code not required by a listed acceptance condition.
3. Measure both model-visible texts and reject duplicated or case-specific
   guidance.
4. Re-run focused tests after any audit change.
5. Record verified behavior separately from inference and pending Windows work.

## Verification record

The following evidence was recorded for the preceding Round 2 implementation.
This Linux/Qwen Code SDK and Skill update does not rerun or supersede its
Windows and model-request results. These historical results do not replace the
release or benchmark gates below and must not be read as verification of the
revised Skill.

- Node REPL: 152 local tests pass. A clean-packed MCP session on Windows
  cancelled an active CUA cell without changing the kernel PID or the
  identities of the persisted `ComputerUse` client, sentinel, or revision
  cursor. The cancelled cell committed no new binding and emitted no late
  result.
- CUA lifecycle: a Windows action that opened an owned modal was reported as
  committed from exact owner-chain evidence even though the provider call
  remained blocked. The isolated worker then terminated; the action was not
  retried.
- UIA isolation: observing the BMPEditor `#32770` modal returned a screenshot,
  exact HWND/owner metadata, and explicit partial/degraded coverage after
  4.35 seconds. Closing the modal rebuilt the worker and the next main-window
  observation returned a complete 37-element tree. The Windows release test
  suite passed 170 platform tests and 3 UIAccess authorization/pipe tests.
- Foreground delivery: the signed worker installed under Program Files handled
  exact foreground input. A click that opened a modal remained committed, and
  the normal foreground transition was not reclassified as acquisition
  failure.
- Typed verification and revisions: a Windows Notepad path retained a refused
  semantic action as `committed: false`, then completed foreground text input,
  two-sample stable verification, and a full-to-diff revision sequence.
- Authorization recovery: forcing a one-second session expiry on Windows
  advanced the client generation from 1 to 2 automatically; the recovered
  client returned the same 108-app snapshot without replacing model-owned
  state.
- Model-visible text: actual requests assembled by fixed Claude Code 2.1.177
  for `claude-opus-4-8` contained the 1,078-character Node REPL instruction
  exactly once in the MCP-instruction message and the 5,690-character Computer
  Use body exactly once when `/computer-use` was loaded. Both matched the
  clean-packed artifacts byte for byte; `forceFull` appears once, and neither
  text contains benchmark, evaluator, score, historical-case, or
  application-specific guidance. Qwen Code's focused request-assembly tests
  verify that progressively discovered MCP instructions are queued for the
  next user turn instead of being lost after the startup prelude is built.

## Computer Use API migration

The Computer Use skill keeps Codex's section structure and workflow. Only the
runtime-specific surface changes:

| Codex `@oai/sky`                  | Qwen CUA SDK mapping                                       |
| --------------------------------- | ---------------------------------------------------------- |
| bundled `sky` singleton           | `ComputerUse.create()` and `close()`                       |
| app name target                   | exact PID and window ID from `listApps` + `listWindows`    |
| `get_app_state`                   | `observeWindow`                                            |
| `element_index`                   | `elementToken`                                             |
| `disableDiff: true`               | `disableDiff: true`                                        |
| screenshot `file://` URL          | `{ mimeType, dataBase64 }` images                          |
| snake-case actions                | typed camel-case SDK actions                               |
| `press_key` combination syntax    | `pressKey` modifiers or `hotkey` keys                      |
| `paste` and `select_text`         | no public high-level SDK equivalent; omitted, not emulated |
| one or more actions, then observe | unchanged                                                  |

The Node REPL MCP instruction exclusively owns JavaScript cell scope,
redeclaration, cancellation, output, and reset behavior. The Computer Use
skill exclusively owns the migrated UI discovery, observation, action, and
screenshot guidance. Neither text contains benchmark policy, evaluator
criteria, historical failures, or application-specific examples.

## Release gate

The functional change, generated bindings, package metadata, native release
metadata, and every required version bump must be complete in the same feature
PR. No PR is created until the user explicitly authorizes that exact PR. No
post-merge recovery/version PR is assumed.
