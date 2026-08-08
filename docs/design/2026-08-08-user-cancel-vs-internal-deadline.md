# Distinguishing a User Cancel from an Internal Deadline

## Problem

A request to a provider SDK can be aborted for two reasons that are
indistinguishable at the error level. When a user presses Esc, the OpenAI SDK
rejects the in-flight request with `APIUserAbortError` and the Google GenAI
path throws a DOMException named `AbortError`. When an internal deadline fires
— a memory-recall budget, a goal judge, a prompt hook, the workflow wall-clock
cap — the same request is aborted through the same signal, so the SDK rejects
with the same abort-shaped error. Nobody cancelled anything, but the error
looks identical to a cancel.

Two logging paths decide whether to report an error based on "was this a user
cancel": the `api_error` telemetry event (`LoggingContentGenerator`) and the
debug log (`OpenAIContentGenerator.shouldSuppressErrorLogging`). Before this
work they used separate, hand-written conjunctions, and `isAbortError` did not
recognise `APIUserAbortError` at all, so an OpenAI-path cancel was logged and
telemetered as an `api_error` (issue #8398; the noise observed in #8356). The
naive fix — suppress whenever the signal aborted and the error is abort-shaped
— is wrong in the other direction: it hides a genuine failure whenever an
internal deadline expires, because that abort is abort-shaped too.

## Design

The decision is not "is the error abort-shaped" but "did the _user_ abort
this". A bare `controller.abort()` is signal-level indistinguishable from Esc,
so the two cases cannot be separated at the consumer. They are separated at the
**producer**: an internal deadline aborts with a reason that says it is a
deadline.

- `isAbortError(error)` answers only "is this abort-shaped" — a user cancel OR
  an internal deadline. It is not a proxy for user intent.
- `isUserCancel(error, signal)` answers "did the user cancel". It requires an
  aborted signal and an abort-shaped error, and **excludes** the case where the
  signal's reason is an `Error` named `TimeoutError`. Both logging gates call
  this one predicate, so they cannot drift apart.
- `timeoutAbortReason(message)` is the producer half of the contract: a
  `TimeoutError`-named `DOMException`. Every internal deadline on a
  model-request path aborts with it (or with `AbortSignal.timeout()`, which
  produces the same shape natively; `combineAbortSignals({ timeoutMs })` is the
  composed spelling when a parent signal is also involved).

The invariant is: **an abort that a model request can observe must carry a
`TimeoutError` reason if it is a deadline, and any other reason otherwise.**
The reason discrimination is deliberately negative-only — it excludes
`TimeoutError` rather than requiring a specific cancel shape — so that the many
real cancel shapes (a bare `AbortError`, a string reason like the daemon/ACP
`'qwen:user-cancel'`) all continue to read as cancels without enumeration.

## Producers and deliberate exclusions

Converted deadline producers, all reaching a model request: goal judge, goal
verifier, goal checkpoint verifier, prompt hook, stall watchdog, workflow
wall-clock cap, and the CLI voice-transcript refinement.

Two timer-driven aborts stay bare on purpose:

- The ACP recovered-parent wait (`create-sub-session.ts`) times out an event
  subscription, not a model request, so no logging gate sees it.
- `runBudget`'s budget stop is a user-configured planned interruption of a
  healthy request, recorded separately as `BudgetExceeded`. Suppressing its
  `api_error` is the correct outcome — reporting it would count an intentional
  stop as a model failure.

## Limits

The invariant is convention, not a type. `isUserCancel` excludes only a
`TimeoutError` reason; every other reason stays cancel-like, so a future
deadline written with a bare `abort()` silently re-creates the bug with nothing
at compile time to catch it. `timeoutAbortReason` gives the contract a single
spelling and a docstring, but adding a producer still requires knowing the
contract exists.

`isAbortError` is broadened by this work (it now matches `APIUserAbortError`),
which changes behaviour at every one of its consumers, not only the two logging
gates: `classifyRetryError`, `mcp-tool`, `artifact-tool`, `geminiChat`,
`fileUtils`, `readManyFiles`, `pipeline`, and the workflow orchestrator. The
two suppression gates were refined to `isUserCancel`; the rest continue to gate
on raw `isAbortError` and are expected to treat a deadline-driven abort the
same as a cancel (retry short-circuit, silent tool-abort) — which is benign for
those consumers but is part of the blast radius a reviewer should confirm.

## Out of scope

This does not address #8356's reported transcript-write blackout — subsequent
successful turns not appended after an abort. That is a separate
recorder/lifecycle matter. This work does change one transcript record: a
suppressed user cancel no longer writes its `api_error` `ui_telemetry` entry,
since a deliberate cancel is not an API error.

## Test plan

- `isUserCancel`: true for a bare-abort and string-reason cancel; false for a
  `TimeoutError` reason (bare `AbortSignal.timeout`, composed via
  `AbortSignal.any`, and manual-controller), for a missing signal, and for a
  non-abort error on a timeout signal.
- Each converted producer: a reason-shape assertion that its deadline aborts
  `TimeoutError`-named; reverting the conversion fails exactly that test.
- Both logging gates: a user cancel is suppressed, a timed-out internal budget
  is still reported, and a real failure racing a cancel is still reported.
- `isAbortError`: recognises the real OpenAI and Anthropic `APIUserAbortError`
  classes, with an `APIConnectionError` negative control.
