# W2 WebShell: change the working directory within a Session

[English](2026-10-09-managed-workspace-w2-webshell.md) | [简体中文](2026-10-09-managed-workspace-w2-webshell.zh-CN.md)

## Problem and baseline

The W2 control plane (#13247) already admits durable, idempotent same-Workspace cwd changes and publishes `session.context.changed`. WebShell shows the bound directory but cannot change it. Session summaries omit the context revision in their TypeScript contract, and the event projector ignores context changes. Baseline: main `15c11bb8982`; #13545 (actor roles) and #13564 (Hosted instruction cache invalidation) remain open.

## Interaction

Place Change directory next to the directory in the Workspace card. A shared Dialog contains a relative-path Input initialized with the current directory. Paths are relative to the Workspace root; `.` means the root. Reject empty and exactly unchanged inputs locally; preserve whitespace, case and Unicode. The server normalizes and verifies paths, existence and containment. No directory browser, creation or cross-Workspace move is included.

Disable new changes during an active turn, pending approval, unconfirmed prompt or cwd change. Keep the composer draft editable during a cwd change, but block sending. Closing the dialog does not cancel the operation; its status remains in the Workspace card. Preserve history, pagination and the current Session. Use shared scoped portals, translated labels, keyboard submission and focus restoration.

## Contracts and authorization

Use existing BFF `/sessions/cwd/change`, `/operations/query` and `/sessions/get`. The optional provider `cwdChange` group has submit/query methods returning the existing cwd operation shape. Extend the summary with optional contextRevision/state and cwdChange capability. Java exposes the group only with an explicit productScope containing tenant/account identity. Daemon and old servers remain unsupported.

The separate BFF slice implements the existing optional `cwdChange` capability using the deployment execution flag, active Session, binding/Registry facts and the same caller authorization predicate as cwd admission. Batch page reads; do not reuse workspaceTurns, which has additional execution-profile constraints. Permission remains authoritative on the server and evolves with #13545. Capability does not promise an idle Session. No endpoints, database tables, operation history, public capability expansion or context-state derivation are added.

## Durable browser intent

Before submitting, persist sessionId, workspaceId, exact target, expectedContextRevision and idempotencyKey in sessionStorage, keyed by provider identity and Session. Fail before sending if the initial write fails. Persist operationId after admission; retain the original request if that update fails. Only one local intent can exist per Session.

Capture revision when opening the dialog. If it changes before submission, show the new directory and require an explicit confirmation before using the fresh revision. A 202 is only admission: continue showing the authoritative committed directory. Poll after 1, 2, then 3 seconds, then every 3 seconds. After 30 seconds or a transport failure, show an unconfirmed result and Continue confirming. Never convert uncertainty into failure or generate a replacement key.

On reload, query a known operation automatically; an intent without an operationId is replayed with its original key and payload only on Continue confirming. The recovery action remains available when cwdChange capability becomes false. Do not provide a local discard that implies cancellation. A definitive first-submit refusal or terminal failed operation releases the local intent, retains the target and explains the error. A revision conflict refreshes the summary and needs a fresh user submission.

After completed, refresh the summary and require its revision to reach resultContextRevision before clearing the intent. A later revision may have a different directory; display that latest directory rather than restoring the operation target. Matching paths alone never prove completion. Abort local work on Session/account changes and ignore late responses.

## Events and isolation

Project context changes as Session events; refresh only the summary, without reloading transcript or synthesizing chat messages. Keep the existing three-second summary poll. Preserve the higher Workspace revision across out-of-order responses while retaining fresh non-Workspace fields. Other tabs learn committed changes through events/polling; their in-flight operation progress is not discoverable in this slice. Server admission and CAS serialize races.

## Delivery and acceptance

Two independently reviewable PRs: frontend adapter/control/recovery/events; BFF capability/OpenAPI/generated types/tests. The frontend is inert against servers without the capability. The BFF must not merge or deploy advertising true until #13564's cwd invalidation fix passes joint acceptance: within the same Hosted attachment, A→B changes both the next turn's file writes and its QWEN.md/AGENTS.md rules. This slice does not fix rewind or instruction editing.

Focused provider, hook, component, event and Java capability/query-budget tests cover lost acknowledgements, refresh, failure, permissions, stale revisions, concurrent requests, account isolation, storage refusal and old servers. Browser verification covers portals, focus and draft/history preservation. Real Java/Hosted verification covers root, spaces/non-ASCII, invalid/escaped paths, busy admission and post-change writes. Run build/typecheck/bundle, focused tests and two clean self-audit passes. Record any unavailable joint gate honestly; do not enable prematurely.

## Behavior test plan and evidence

The tracked [behavior E2E plan](../plans/2026-10-09-managed-workspace-w2-webshell-e2e.md) separates browser simulation, real process writes and the outstanding rules gate. The screenshots use an identity-scoped Java provider fixture with intercepted BFF responses; they demonstrate UI behavior, not server completion.

Before, a capability-less server offers no switch entry:

![Before](assets/w2-webshell-before.png)

After, a confirmed operation and authoritative summary show B while the same draft/history remain:

![After](assets/w2-webshell-after.png)
