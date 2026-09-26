# Delete the Current Standalone Session from the Sidebar

[English](2026-09-26-current-standalone-delete.md) | [简体中文](2026-09-26-current-standalone-delete.zh-CN.md)

Status: implemented and verified locally for [Issue #12669](https://github.com/QwenLM/qwen-code/issues/12669). Four targeted test files passed (1570/1570), repository typecheck and the final full build passed, and the isolated real-daemon single-tab and two-tab flows were observed.

## 1. Problem and current state

At the baseline, the Web Shell sidebar listed standalone sessions but disabled Delete on the current row. Removing that disabled condition alone would fail: the standalone batch delete route returns a per-session `session_busy` error while this tab is attached or a prompt is active. [PR #12636](https://github.com/QwenLM/qwen-code/pull/12636) retained the safe disabled state and left the confirm → leave → delete flow for this issue. Its maintainer verified on a real daemon that New task released the attachment before deletion in two trials; those trials are separate from this change's verification below.

`StandaloneRecents` owns the confirmation and batch delete request. `WebShellSidebar` supplies the row and New task actions. `App` implements global New task through `createNewSession({ kind: 'global' })`, which calls session `clearSession()`. At the baseline, `clearSession()` awaited detach but logged and swallowed detach errors; New task's `true` therefore did not prove that the daemon released the client. The New task wrapper passed to `StandaloneRecents` also discarded its Promise. The SDK treats detach without a `clientId` as a no-op, so resolving that call would not prove release either.

## 2. Goal and scope

- Let an idle current standalone session be deleted from either sidebar Delete entry after confirmation.
- Delete the session selected for confirmation only after this tab's detach has succeeded; preserve the daemon's protection of sessions still in use.
- Keep cancellation, noncurrent standalone deletion, and regular New task behavior unchanged.
- Limit the change to the Web Shell sidebar and its session actions. The `/delete` picker, daemon routes, and other session sources are outside this issue.

## 3. Implemented flow

1. Both sidebar Delete entries share one disabled rule: an operation already in progress, or a current session running work, remains disabled. For the current row, use App's live prompt, active-work, and streaming state even when the sidebar summary is stale. The current idle standalone row is enabled. Do not disable from listed `clientCount`: the list does not continuously poll, so a stale count could indefinitely block a now-deletable session.
2. Clicking Delete opens the existing confirmation without leaving. On confirmation, capture the selected session ID. If it is no longer current, use the existing noncurrent batch delete path. If it is current, invoke a dedicated, awaitable App callback with that expected ID. The callback rechecks live running state at confirmation; if work started after the dialog opened, it stops before leaving or deleting and shows a warning.
3. The callback reuses `createNewSession({ kind: 'global' })` with a narrow strict-clear option. Before clearing, it verifies that the attached session is the expected ID and that both the SDK session and connection hold the same nonempty `clientId`. For this call, `clearSession()` must reject a missing/mismatched attachment, absent `clientId`, or detach failure instead of reporting success. This check is necessary because SDK detach without a `clientId` is a no-op. Ordinary New task keeps its existing best-effort cleanup behavior. A successful detach response is the sequencing barrier for deletion; no delay, retry, or second detach is added.
4. Only after successful leave does `StandaloneRecents` send `deleteStandaloneSessions([capturedId])`. Its existing per-ID batch result handling removes the row only for `removed` or `notFound`. A leave failure stops before the delete request. A delete failure, including `session_busy` from another tab or a race, keeps the row, reports the error, and refreshes the list so its attachment state is current. The daemon remains authoritative.
5. Keep the operation lock across leave and delete. Once confirmation starts the operation, keep the dialog open and block Cancel, Escape, backdrop, and close-button dismissal until it settles; closing the dialog must not make an in-flight deletion appear cancelled. If another navigation supersedes the leave, do not delete a different session or treat that navigation as proof that the expected session detached. The existing New task error reporting should not be duplicated by a second sidebar error.

## 4. Constraints and risks

- `clearSession()` currently clears local state before awaiting detach. If strict detach fails, the tab may show a fresh draft while the old row remains. The UI must not claim deletion succeeded; the failure should be visible. Preserve the original row and verify the resulting navigation state.
- The sidebar summary can lag behind the current session's prompt or streaming state. The live App state must control the current row, and confirmation must recheck it immediately before leaving.
- A listed `clientCount` may be stale, including for multi-tab use. A second tab can keep the session busy after this tab detaches; surface the batch `errors[]` result rather than assuming an HTTP error status or overriding the daemon guard.
- The selected ID is fixed at confirmation. A session switch during the dialog or asynchronous leave must not redirect deletion to the newly active ID.

## 5. Validation

- Four targeted Web Shell test files (`App.test.tsx`, `StandaloneRecents.test.tsx`, `WebShellSidebar.workspace-removal.test.tsx`, and `actions.test.ts`) passed 1570/1570 tests. Their regression cases cover strict detach ordering and rejection, the current-row controls, the live-running recheck, failure reporting, and navigation races. Repository-wide typecheck passed.
- In an isolated real-daemon single-tab run, confirmation was followed by detach HTTP 204, then batch delete HTTP 200 with the original ID in `removed`; the row disappeared. In a two-tab run, `clientCount` changed from 2 to 1 after the first tab detached; batch delete returned HTTP 200 with per-ID `session_busy` in `errors[]`; the row remained and the page showed an error. After the second tab left through New task, the count fell to 0; retrying Delete in the first tab's existing confirmation removed the original session. These are this change's E2E observations, separate from the maintainer's earlier 2/2 trials.
- The real-daemon runs did not inject detach failures or active prompts; those branches have focused unit coverage. The final repository-wide `npm run build` and `npm run typecheck` both exited 0. The global-CLI baseline dry run was unavailable because `qwen` is not installed on this machine. The real-daemon runs used isolated temporary Conversations and discovery paths.

## 6. Acceptance criteria

- Confirming Delete for a current idle standalone session leaves that exact session, waits for confirmed detach with a valid `clientId`, and requests deletion of its captured ID once.
- Live running state disables the current row and is rechecked on confirmation. Cancelling before confirmation or a failed leave sends no delete request; the dialog cannot be dismissed while leave and deletion are in flight. Failed deletion retains the row and explains the failure. Other clients and active prompts remain protected by the daemon.
- Noncurrent standalone deletion, regular New task, and the `/delete` picker retain their behavior. English and Chinese user-facing text and both versions of this design stay aligned.
