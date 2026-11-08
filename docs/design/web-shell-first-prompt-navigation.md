# Web Shell: first prompt survives session navigation

[English](web-shell-first-prompt-navigation.md) | [简体中文](web-shell-first-prompt-navigation.zh-CN.md)

Status: implemented (2026-11-08)

## Problem

In Web Shell a new chat is a draft: the daemon session is created only when
the first prompt is submitted. If the user submits a prompt and quickly
clicks another session while creation is in flight, the session is created
on the daemon (it appears in the sidebar) but the prompt is never dispatched.
The user sees an idle session and a silently lost prompt.

## Current state

Three guards cooperate to drop the submission:

1. `packages/web-shell/client/daemon/session/actions.ts` — `createSession`
   computes `userMovedAway` after the detached create resolves. When the
   connection moved (or the session was manually cleared), it detaches the
   created client and throws `AbortError('Session creation interrupted')`.
   The daemon-side session survives, idle.
2. `packages/web-shell/client/utils/sessionPreparation.ts` —
   `createAndAttachSessionForPrompt` verifies the current session identity
   before/after attach and aborts when it changed.
3. `packages/web-shell/client/App.tsx` — `sendPrompt` re-checks
   `admissionSourceIsCurrent` after `ensureSessionForPrompt`; when the user
   left, it returns without dispatching. `submitPromptFromEditor`'s catch
   swallows the error because the admission owner no longer matches.

The guards exist so a slow create cannot hijack navigation (pinned by
`actions.test.ts` "does not replace navigation after a slow detached create").
That goal stays; what changes is the fate of the submitted prompt.

## Goals

- A submitted first prompt is dispatched to its newly created session even
  when the user navigates away during creation. The turn runs on the daemon
  in the background, exactly like a prompt sent in an existing session before
  switching away.
- Navigation is never blocked or hijacked: the user stays on the session they
  clicked; the created session does not steal the connection.
- The draft composer text is consumed on successful dispatch (via the
  existing `sourceChanged` branch of `commitAccepted`) and preserved on
  failure, so the prompt is neither duplicated nor silently lost.

## Non-goals

- No change to the `userMovedAway` behavior of non-prompt `createSession`
  callers (e.g. `resolveSessionForWorkspace`): they still abort on navigation.
- No optimistic transcript block for the detached prompt: the visible
  transcript belongs to another session. Opening the created session replays
  the admitted prompt from the daemon.
- No waiting for turn completion in the detached path; admission is the
  delivery guarantee.

## Solution

### `createSession` keeps the created client for prompt flows

New option `keepOnNavigation?: boolean` plus an outcome holder
`navigationOutcome?: { bound: boolean }`. In the detached-create branch, when
`manualSessionClearRef.current || userMovedAway` and `keepOnNavigation` is
set, `createSession` returns the created client without binding
(`sessionRef`, `setConnection`, stable-client-id persistence all skipped) and
marks `navigationOutcome.bound = false`. All other paths are unchanged.

### `createAndAttachSessionForPrompt` gains a detached preparation path

The helper is used only by the first-prompt flow, so it always passes
`keepOnNavigation: true`. When the outcome says the client was not bound:

- `onSessionAllocated` still fires (catalog provisional title, allocation
  bookkeeping).
- `onSessionCreated` receives the created client as a second argument; the
  App callback renames through `client.updateMetadata` instead of
  `sessionActions.renameSession` (which targets the current session), then
  performs the unchanged catalog/host notifications.
- Attach and the identity checks are skipped. Model, Plan mode, and reasoning
  effort are applied through the created client (`setModel`,
  `client.setSessionApprovalMode`, `setConfigOption('reasoning_effort')`)
  with the same fail semantics as the attached path (model failure is fatal
  only when a model-bound reasoning choice is pending).
- The result carries `detachedSession` (the created client). Preparation
  failures release the session through the created client (`close()`), not
  through `sessionActions.releaseSession`, which targets the current session.

### `ensureSessionForPrompt` returns the allocation result

Return shape changes from `string | undefined` to
`{ sessionId: string; detachedSession?: DaemonSession } | undefined`.
Call sites:

- `sendPrompt`: when `detachedSession` is present, dispatch through the new
  `sendDetachedPrompt` action (below), then commit the draft via the
  navigation-safe `commitComposerAccepted`, emit the host `submit` session
  change, and signal `sessionCatalogController.promptAdmitted`. Failures are
  reported with a toast regardless of the current owner and mark the catalog
  admission uncertain; the draft text is left intact.
- `!cmd` shell flow: dispatch through `detachedSession.shellCommand`, then
  detach the client.
- `/goal` and Goals dialog: `createGoalForAllocatedSession` already targets
  the session by id, so a detached allocation proceeds; the client is
  detached immediately (the id-based dispatch never uses it), and the local
  transcript echo is skipped when detached.
- `ensureAgentMentionSession`: consumes `sessionId` only and detaches the
  client immediately; the mention posts by id through workspace routes.

Every receiver of an unbound client must release it: the client is a live
daemon-side registration, and `POST /session/:id/detach` is the only release.
Prompt and shell detach after their dispatch settles; goal and mention
detach at allocation because their dispatch never touches the client.

### `sendDetachedPrompt` action

New admission-only action in `actions.ts`, typed in `types.ts`:

- Reuses `normalizePromptFiles`, `discardsSlashCommandAttachments` (with an
  injected current-session predicate so the detached client passes, and the
  initial command snapshot keyed on client identity so a detached dispatch
  classifies against the created session's own catalog, never the
  navigated-to session's), and `promptContentWithUploadedAttachments` for
  attachment upload.
- Builds the same prompt request as `sendPrompt` (`eventDetailMode`,
  `_meta.qwen.submittedPrompt`, `inputAnnotations`, `retry`) and submits via
  `session.submitPrompt` (non-blocking admission).
- Never writes the transcript store, prompt status, or connection state.
- Fires `onAdmissionStarted` / `onAdmitted`, removes uploaded attachments on
  definite rejection, and detaches the client in `finally`. The daemon keeps
  the session and runs the turn; a later `loadSession` attaches fresh.

## Design decisions

- **Dispatch at admission, not turn completion.** Matches existing-session
  semantics: once the daemon accepts the prompt, switching away is safe.
- **Outcome holder instead of reading the connection after create.**
  `setConnection` is the raw React setter in the actions factory; the
  connection ref can lag a render, so only `createSession` itself can tell
  whether it bound the client.
- **No store writes from the detached path.** The visible transcript belongs
  to the session the user navigated to; injecting a user block there would
  corrupt it.
- **Keep the session on dispatch failure.** Admission may be uncertain; the
  session stays in the catalog so the user can inspect or resend. Only
  preparation failures (before any dispatch) release it.

## Constraints and risks

- The detached client is short-lived in every flow: prompt and shell detach
  after dispatch settles, goal and mention detach immediately after
  allocation. Event streaming for the turn is picked up when the user opens
  the session (or via background-turn live state).
- Background-turn notification parity is a follow-up: the provider's
  `turnNotifications.admit` is gated on the current session and its observer
  only watches the active session's events, so a detached first prompt does
  not register a "turn finished in the background" notification. The prompt
  itself is delivered and runs; wiring notification parity needs its own
  change to the admission gate and scope lifetime.
- `registerAcceptedAttachmentSources` self-guards on `sessionRef.current` and
  is a no-op for the detached client; source decoration is best-effort.
- Slash-command attachment classification reads the connection's command
  snapshot only when the client is the current session; a detached client
  starts unresolved and reads `supportedCommands` from itself, so a
  same-named command in the navigated-to session's catalog cannot discard
  the created session's attachments. The result is never published to the
  current connection.
- Residual window: a click that lands after the create resolved and bound the
  connection, but before the navigation publishes, still goes through the
  attached path's identity checks (unchanged behavior). The reported race —
  clicking while the create is in flight — is the detached path.

## Validation plan

- E2E (mock daemon, deterministic): `client/e2e/web-shell.first-prompt-switch.spec.ts`
  holds `POST /session`, submits a prompt, clicks another session, releases
  create; asserts the prompt reaches the created session and the URL stays on
  the clicked session. Reproduced red before the fix.
- Unit: `actions.test.ts` (unbound create outcome, detached dispatch admission
  and cleanup), `sessionPreparation.test.ts` (detached preparation skips
  attach, applies settings through the client, releases on failure),
  `App.test.tsx` (draft submit + navigation dispatches detached, commits the
  draft, keeps the current transcript clean).
- Existing navigation-guard tests must stay green for non-prompt creates.

## Acceptance criteria

- Submitting a first prompt and switching sessions during creation dispatches
  the prompt to the created session; the turn runs in the background.
- The user's navigation target is never replaced by the created session.
- On dispatch failure the draft text is preserved and an error is surfaced.
- Non-prompt `createSession` navigation behavior is unchanged.
