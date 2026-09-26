# Managed Agent session surfaces

The product target is now to make Managed Agent the daemon's default execution
implementation; see [the default migration design](managed-agent-daemon-default.md).
The separate surface described here remains the implemented experimental entry
point. It does not establish ordinary-session protocol or coding-capability parity.

## Status and scope

Implemented on the experimental P8 checkpoint `4df73b9c76`.
This slice adds the Gateway session catalog, durable display history, explicit
turn and Runtime status, recoverable client streaming, and a Web Shell surface
with create, follow-up, and cancellation. Runtime activation and Kubernetes
placement remain the independent P9 workstream.

## Ownership

A displayed Managed task identifies the Gateway Session for its whole lifetime.
Runtime replacement or absence does not create, remove, or rename that task.
Ordinary session discovery continues to hide `managed-gateway` Runtime sessions.
The Agent View roster remains authoritative for supervisor-owned background
tasks; it is not the store for Gateway-owned Managed sessions. Shared UI does
not transfer execution ownership between these systems.

Managed reads use the Gateway's persisted binding and presentation journal.
They never attach, restore, prepare, or create an ACP Runtime. Mutations resolve
the bound workspace and fail closed if it is removed or untrusted. An explicit
unregistered creation `cwd` is rejected even when only one workspace is mounted.

## Durable presentation and recovery

The inbox remains the authority for admission and Prompt outcome; model
conversation history remains the authority for the next model request. A
Gateway-owned append-only presentation journal records user messages, assistant
text, supported reasoning summaries, bounded Tool details, and lifecycle events
for display. It is a projection, not a third executor or a replacement roster.

Every public event carries a stable Session ID, Prompt ID, and monotonically
increasing per-Session event ID. Journal writes complete before events are
exposed to clients. Restart restores IDs and display state; a partial trailing
record is discarded without replaying model or Tool execution. Runtime readiness
after Gateway restart is unknown until a new owned preparation confirms it.
Ordered inbox recovery repairs missing admissions and terminal presentation events without duplicating already recorded turns. Ambiguous execution
is reported as interrupted/failed and is never silently resubmitted.

Upgrading an existing P8 state directory restores admission messages and outcomes
from the inbox. Historical assistant/Tool presentation that predates this journal
is not reconstructed from the model's separate conversation store. Newly
recorded display history survives restart. The Gateway state directory is scoped
to its listening address and port; use the same configured port on restart.

The current prototype scans the append-only journal for a transcript page. Page
responses and live caches are bounded; on-disk compaction, retention, and indexed
history lookup remain future work.

Transcript pages are chronological bounded windows, with an older-page cursor
and a latest-event watermark captured together. Initial load gets the latest
window and subscribes after that watermark. Older pages are prepended by stable
event ID. Reconnect reuses the last received ID; a gap triggers a fresh snapshot,
not another Prompt. Page switches abort reads/subscriptions and fence late data.

## Public contracts

All routes retain existing daemon authentication. The experimental local
operator identity and stable Managed client correlation are not a production
multi-tenant authentication system. Runtime tokens and internal bindings never
appear in presentation payloads. Production principal derivation remains at the
trusted Gateway boundary, not in browser-selected tenant/user headers.

| Route                                                 | Behavior                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /managed/sessions?cwd=&limit=&cursor=`           | Caller-scoped, bounded Gateway catalog; stable creation ordering for pagination.        |
| `GET /managed/sessions/:id`                           | Durable summary, current Prompt, independent Runtime state, and operation capabilities. |
| `GET /managed/sessions/:id/transcript?before=&limit=` | Chronological event window, `olderCursor`, and `lastEventId`.                           |
| `GET /managed/sessions/:id/events`                    | Authenticated resumable SSE with `Last-Event-ID`; disconnect only stops observation.    |
| `POST /managed/sessions`                              | Existing idempotent initial Prompt admission.                                           |
| `POST /managed/sessions/:id/prompts`                  | Existing idempotent sequential continuation.                                            |
| `POST /managed/sessions/:id/cancel`                   | Targets an explicit `promptId`; durable cancellation request, then model/Tool abort.    |

Client methods use native REST even when ordinary daemon traffic uses ACP.
Uncertain create/follow-up responses retain their idempotency key and payload
for retry. Cancel targets the captured Prompt ID, never an unspecified current
turn that could have changed. A completion that has already committed remains
completed; an accepted cancellation request is not itself a terminal outcome.

## State and rendering

Turn state distinguishes admitted, agent running, waiting for Runtime, Tool
running, cancelling, completed, failed, and cancelled. Runtime state separately
distinguishes unknown, starting, ready, and failed. No-Tool completion remains
completed if warmup later fails. Runtime lifecycle callbacks are fenced to the
preparation observed by the current turn so stale callbacks cannot change it.

`tool_requested` means a Tool was requested. Only a new `tool_started` event,
after manifest validation and immediately before execute, means it is running.
Tool presentation uses bounded argument/result summaries and explicit truncation
indicators. It never exposes provider credentials or protocol-internal handles.

The Web Shell adds a capability-gated Managed Agents panel with a catalog,
existing message rendering, separate Runtime status, text composer, and cancel.
Its URL query restores the Managed selection independently of ordinary Runtime
session paths. Buttons read server capabilities; model selection, approvals,
fork, archive, and other unsupported ordinary-session actions are not mounted.
Failed or cancelled first turns require a new session; a failed later turn may
continue from the last successfully committed conversation.

## Operator entry point

Start the Gateway with `qwen serve --experimental-managed-agents --port 4170`
and the existing model configuration. Omit `--no-web` to use its Web Shell.
For a separate Runtime worker, keep the P8 remote Runtime flags and credentials.
The sidebar shows Managed Agents only when the Gateway advertises
`managed_sessions`; cancellation additionally requires `managed_session_cancel`.
The browser's Managed client ID is stable per daemon URL. Clearing that browser
storage creates a new catalog correlation; it does not delete server history.

## Verification

Verify each public route at the HTTP boundary, including caller isolation,
removed/untrusted workspace behavior, stable pagination, and read-only Runtime
effects. Restart must preserve completed answers and IDs. Delayed Runtime,
Tool start, no-Tool completion plus warmup failure, queued/running cancellation,
cancel-vs-complete, stream gaps, duplicate events, uncertain request retries, and
page-switch races require focused regression coverage. SDK transport tests must
exercise both ordinary REST and an ACP-configured client. Web Shell tests must
prove that opening Managed history never invokes ordinary Session load/restore.

Files affected: Managed Gateway service/events/model orchestration and routes,
core inbox cancellation persistence where needed, daemon capability reporting,
TypeScript daemon SDK, Web Shell navigation/panel/messages, and collocated tests.

No new distributed scheduler, authentication platform, or Runtime placement
implementation is introduced by this slice.

## Validation on 2026-09-08

Full repository build and CLI bundle passed on macOS with Node 22.22.3. All
workspace package typechecks passed. The integration typecheck still reports
four baseline errors: one implicit callback type in the channel daemon worker
and three source/dist `ProcessRegistry` identity conflicts. A clean archive of
P8 `4df73b9c76` reproduced those same four errors with the same dependencies.

Focused core persistence tests (22), CLI Managed/service/HTTP/orchestration tests
(63), and SDK Managed/SSE tests (22) passed. Web Shell's complete App regression
suite passed alongside the Managed and standalone URL tests; the final Chinese
label regression passed after its dictionary ordering fix. Changed-source ESLint
and `git diff --check` passed.

An isolated real Gateway and delayed Runtime worker, using a deterministic local
model endpoint, passed create, exact retry, caller/auth isolation, unregistered
workspace rejection, restart, transcript pagination, SSE replay, sequential turns,
exact cancellation, and an actual file read. The cancelled/completed sessions
survived another restart with no model replay. Browser checks passed creation,
refresh restoration, continuation, cancellation, and Chinese rendering. Gap,
network retry, selection races, and approval visibility are covered by component
and route tests; they are not claimed as manual browser checks.

The reproducible local test plan and full process/browser report are in
`.qwen/e2e-tests/managed-agent-session-surfaces.md`; its harness is
`.qwen/scripts/managed-agent-session-surfaces-e2e.mjs`. These working artifacts
are intentionally git-ignored by repository convention. No external model
provider, production deployment, Windows, or Linux run was used for this check.

## Local Runtime activation (P9a)

The [P9a local Runtime activation design](managed-agent-local-runtime-activation-p9a.md)
implements opt-in automatic worker startup, workspace reuse, owned-worker fencing,
cancellation, and awaited cleanup. Its validation section records the macOS
process checks and remaining platform/E2E limits. Fixed-URL and in-process
providers remain available without the auto-local flag.

## Live progress visibility

The Managed transcript must have a bounded flex column around the shared
MessageList. That list owns scrolling and follows new messages; letting it grow
inside a block with hidden overflow clips new thinking, tool activity, and
answers instead of scrolling them into view.

A compact status above the composer shows submission/loading immediately, then
the active Managed phase and elapsed time from admission. It remains visible
while reading earlier messages and during silent model/tool intervals, explains
why another prompt cannot be sent, and disappears when the turn finishes. Its
state comes from the Managed session, independently of ordinary chat streaming
and Runtime readiness. Existing transcript rows show thinking summaries and tool
details; no second event stream or model request is needed.

Regression checks must cover a long transcript in a real browser, first and
continuation turns before any model content, incremental thought/tool rows,
silent intervals, completion/cancellation, and session switching. A mocked
MessageList alone cannot verify clipping or automatic scrolling.

The 2026-09-08 macOS preview reproduced an 11,551px-tall message list clipped by
a 660px block parent. After the fix, the parent and list both measured 660px;
the list scrolled its 1,631px content to the bottom while the parent stayed
unscrolled. The existing session and Runtime were preserved. Build, bundle,
workspace package typechecks, and 26 focused Managed tests passed; root
integration typechecking still reports the four known baseline errors above.

The committed Playwright suite
`packages/web-shell/client/e2e/web-shell.managed-progress.spec.ts` exercises the
full Web Shell and SDK SSE parser against deterministic HTTP/event fixtures.
Its two `@smoke` cases are included by the existing Web Shell smoke CI job:

- A long successful transcript remains bounded and scrolls to the latest
  thought, tool, and answer. Phase and elapsed time remain visible before
  content arrives, and completion restores the composer.
- After a successful first turn, cancelling the next turn sends its exact
  prompt ID. The cancellation acknowledgement keeps sending disabled until
  terminal settlement; a subsequent prompt continues the same session.

Run from `packages/web-shell` with an isolated Vite port and an unreachable
fallback daemon, keeping the user's preview and real model out of the test:

```sh
QWEN_DAEMON_URL=http://127.0.0.1:1 PLAYWRIGHT_PORT=5197 \
  npx playwright test client/e2e/web-shell.managed-progress.spec.ts \
  --project=chromium --workers=1
```

These browser tests verify rendering, scrolling, request routing, and event
consumption. Gateway execution and Runtime lifecycle remain covered separately;
the cancellation fixture assumes an earlier committed turn, not a cancelled
bootstrap turn. Loading, session-switch races, and other terminal states retain
their focused component coverage.

On macOS Chromium, both Managed cases and the two existing ordinary compact
thinking cases passed three consecutive runs (12 checks). Restoring the old
transcript wrapper made the long-transcript case fail its height, clipping,
overflow, and scroll-position assertions; the original source was then restored.
Build, package typechecks, ESLint, and formatting passed. Root integration
typechecking retained the same four baseline errors noted above.
