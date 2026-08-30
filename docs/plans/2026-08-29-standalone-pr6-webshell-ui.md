# Standalone PR6 WebShell Product UI Plan

## Goal

Turn the explicit daemon session contexts delivered by PR5 (#10418) into the
visible standalone-chat product defined by
`docs/design/standalone-daemon-sessions.md` (§PR6). Home and global **New
Chat** create standalone sessions on capable daemons; project-scoped entry
points stay workspace-bound; a top-level **Recents** group manages standalone
sessions through their full lifecycle; standalone chats hide every
project-only surface. No behavior falls back to the primary workspace unless
the daemon lacks `standalone_sessions_v1`.

This PR touches only `packages/web-shell`. The #9811 WebShell cutover
(`fe34a5cf22`) moved the PR5 provider surface from `packages/webui` into
`packages/web-shell/client/daemon/session/`, so PR6 is fully contained in one
package. It adds no daemon route and no SDK method.

Suggested title: `feat(web-shell): Add standalone chats`.

## Merged Contract This PR Consumes

Verified against `origin/main` (PR3 `34a6e918b6`, PR4 `7357136dd1`, PR5
`ac761e11c2`, cutover `fe34a5cf22`).

### Daemon (packages/cli/src/serve)

- Routes registered by `registerStandaloneSessionRoutes`
  (`routes/standalone-sessions.ts:247`):
  `POST/GET /standalone/sessions`, `GET /standalone/sessions/:id`,
  `POST .../load`, `POST .../resume`, `POST .../repair-directory`,
  `PATCH .../metadata`, `GET .../export`, `POST .../archive`,
  `POST .../unarchive`, `POST .../delete`.
- Capability `standalone_sessions_v1` registered at
  `capabilities.ts:136`, advertised only when the full dependency set is
  installed.
- Standalone creation rejects workspace-only request keys (`cwd`,
  `workspaceCwd`, `sourceType`, `sourceId`, `sessionScope`, `branch`,
  `worktree`) with `400 invalid_request`.

### SDK (packages/sdk-typescript/src/daemon)

- `STANDALONE_SESSIONS_CAPABILITY = 'standalone_sessions_v1'`
  (`standalone-sessions.ts:16`).
- `DaemonClient`: `createStandaloneSession` (generates the UUID, wraps
  response loss into `DaemonStandaloneCreationOutcomeUnknownError` carrying
  `sessionId` + exact-lookup `recovery`, never auto-retries; accepts only
  `sessionId?`, `modelServiceId?`, `approvalMode?`),
  `listStandaloneSessions(Page)`, `getStandaloneSession` (exact lookup:
  creating / summary / not-found), `loadStandaloneSession`,
  `resumeStandaloneSession`, `repairStandaloneSessionDirectory`,
  `renameStandaloneSession`, `exportStandaloneSession`,
  `archiveStandaloneSessions`, `unarchiveStandaloneSessions`,
  `deleteStandaloneSessions` (batch result with `removed`, `notFound`,
  `errors`, `fileCleanupPending`). All standalone methods are
  capability-gated.
- `DaemonSessionClient.createStandalone / loadStandalone /
resumeStandalone` statics and the `{ kind: 'standalone' }` restore
  strategy (`DaemonSessionClient.ts:444-485`, restore dispatch at :710).

### Session provider (packages/web-shell/client/daemon/session, post-#9811)

- `DaemonProductSessionContext` (`types.ts:71`):
  `{ kind: 'workspace'; cwd } | { kind: 'standalone' } | { kind: 'live' }`.
- `DaemonSessionProviderProps.sessionContext` (types.ts:160) alongside
  legacy `workspaceCwd`; conflicts throw before any request.
- Actions `createSession` / `loadSession` / `resumeSession` accept
  `options.sessionContext` (types.ts:438-471). Standalone create is not
  retried and is exempt from the generic 30 s action timeout; Live create is
  rejected by this provider.
- The standalone creation lane (`createDetachedStandaloneSession`,
  `DaemonSessionProvider.tsx:3968`) forwards only `modelServiceId` and
  `approvalMode` to `DaemonSessionClient.createStandalone` — workspace-only
  fields never reach the daemon.
- Connection state exposes `sessionContext` and
  `standaloneSession?: DaemonStandaloneConnectionState`
  (`{ projectlessOutputDirectory?, workingDirectory?, creationRecovery?,
errorCode? }`, types.ts:76-82, 94-98). Directory error codes are copied
  into `standaloneSession.errorCode` for UI branching.
- `session-context.ts` helpers: `resolveProviderSessionContext`,
  `resolveActionSessionContext`, `sessionContextKey`,
  `restoreSessionContextMatches`, `getDaemonErrorCode`,
  `isDaemonErrorExplicitlyNonRetryable`, `getStandaloneConnectionState`.
- PR5 isolation guarantee: standalone/Live sessions skip workspace
  providers, skills, ACP preheat, Git status, and workspace event
  invalidation inside the provider already.

## Entry-Point Routing

Fixed by the umbrella contract; PR6 wires each visible entry point to an
explicit context:

| Entry point                                      | New-session context      |
| ------------------------------------------------ | ------------------------ |
| Home / global **New Chat**                       | `standalone`             |
| **New Chat** inside a selected or locked project | `workspace`              |
| Goals and Git entry points                       | `workspace`              |
| Current-session **New Chat**                     | Inherit explicit context |
| Live Voice                                       | `live`                   |

Implementation map (`packages/web-shell/client`, line numbers verified
against `origin/main` after the #9811 cutover; the product UI currently has
zero `sessionContext` references and passes legacy `workspaceCwd`
everywhere):

- **Home / global New Chat** — sidebar primary nav `handleNewSession()`
  (call site `components/sidebar/WebShellSidebar.tsx:5097`) →
  `createNewSession()` (`App.tsx:8641`). Today this only clears; creation is
  lazy. With capability, it sets pending context `{ kind: 'standalone' }`.
  The Home first-prompt path (`ensureSessionForPrompt`, `App.tsx:6179`,
  target-cwd resolution inside it →
  `utils/sessionPreparation.ts#createAndAttachSessionForPrompt`) consumes
  the pending context instead of resolving locked/selected/primary cwd.
- **Standalone creation omits workspace-only fields** (review P1).
  `createAndAttachSessionForPrompt` always passes
  `sourceType: WEB_SHELL_SESSION_SOURCE_TYPE` and may pass
  `worktree`/`branch`; the daemon rejects all of these on the standalone
  route, and the provider's standalone lane accepts neither. The creation
  flow therefore branches: a standalone pending context dispatches
  `createSession({ sessionContext: { kind: 'standalone' }, approvalMode? })`
  only — never the generic helper's `sourceType`/`worktree`/`branch`
  payload. Tests assert the exact request body for both branches.
- **Project-scoped New Chat** — `handleNewSession(wsCwd)`
  (`WebShellSidebar.tsx:5514`) → `createNewSession(workspaceCwd)`;
  unchanged, pending context `{ kind: 'workspace', cwd }`.
- **Goals** — `onCreateGoal` (`App.tsx:13223`) allocates through
  `createNewSession(undefined, { keepView: true })` +
  `ensureSessionForPrompt`; stays workspace-bound (locked/selected/primary
  cwd), ignoring any standalone pending context.
- **Git** — `resolveSessionForWorkspace` (`App.tsx:6661`) and the composer
  git chips (gated by `gitModeEligible`, `App.tsx:6763`); stays
  workspace-bound.
- **Current-session New Chat** — `createNewSession()` inherits the active
  `connection.sessionContext`: standalone → pending standalone, workspace →
  pending workspace with the current cwd (today's behavior). A Live current
  session routes through the existing Live-specific `startLive('new')` path
  (`client/live/useLiveVoice`), never a silent remap to standalone — the
  routing contract's "inherit explicit context" row stays intact (review
  P1).
- **Split view excludes standalone sessions in PR6** (review P1): pane
  identity is persisted as bare `sessionId` strings (split URL,
  sessionStorage) and pane ownership derives from workspace catalogs, so a
  standalone pane has no context source after a cold split URL or refresh
  and would fall through to workspace resolution. Standalone rows get no
  split entry point; context-bearing pane descriptors are a follow-up.
- **Context propagation** — `WorkspaceSessionProvider`
  (`components/WorkspaceSessionProvider.tsx`) still passes legacy
  `workspaceCwd` into `DaemonSessionProvider`; PR6 passes the resolved
  `sessionContext` prop instead (the provider normalizes legacy cwd at its
  compatibility boundary, so both forms remain valid during the cutover).
- **Loading existing sessions** — `loadSidebarSession` (`App.tsx:9114`)
  currently passes `{ workspaceCwd }`; for standalone entries it calls
  `loadSession(id, { sessionContext: { kind: 'standalone' } })`.

Legacy callers that pass only `workspaceCwd` keep today's behavior
untouched.

## Capability Dual Behavior

Read the capability from `useWorkspace().capabilities.features` —
`DaemonWorkspaceProvider` fetches `client.capabilities()` once at startup,
before any session exists, so entry points (which fire before a session)
must not rely on the session-scoped `connection.capabilities`. Compare
against `STANDALONE_SESSIONS_CAPABILITY` from `@qwen-code/sdk/daemon`.

The capability value is tri-state (review P1), and only one state may fall
back to legacy behavior:

- **Loading** (`capabilities === undefined` while the startup fetch is in
  flight): Home and global New Chat wait — the standalone decision is
  disabled, not defaulted. Treating loading as absent could silently create
  a primary-workspace session on a capable daemon.
- **Loaded-absent** (old daemon): preserve legacy behavior — global New
  Chat targets the primary workspace. Do not call any standalone route. An
  informational hint that standalone chats need a daemon upgrade is
  allowed.
- **Load error**: fail closed with an explicit retry; no session creation
  in either context until capabilities resolve.
- **Loaded-present, creation fails**: display the structured error and
  preserve standalone intent for retry. Never silently create a
  primary-workspace session; never downgrade the context after a `503`
  ownership/runtime failure or a `409` directory conflict.

## Deferred Creation and Pending Context

WebShell creates the daemon session lazily on first prompt for the Home
flow (`createNewSession` only clears; `ensureSessionForPrompt` materializes
on submit). PR6 stores an explicit pending context alongside that deferred
intent:

- A new App-level `pendingSessionContext:
DaemonProductSessionContext | undefined` state, set by every entry point
  above. Pending context is a `DaemonProductSessionContext`, never a bare
  `undefined` cwd — "no cwd yet" is not standalone semantics.
- `ensureSessionForPrompt` (`App.tsx:6179`) prefers the pending context:
  `{ kind: 'standalone' }` → the standalone creation branch (no
  workspace-only fields); a workspace pending context → today's exact-cwd
  path; none → legacy locked/selected/primary resolution.
- **Pending context stays authoritative until attach commits** (review
  P1). Ordinary `409`/`503` creation failures do not publish a standalone
  connection context, and a cleared provider can still hold the previous
  workspace context — so routing and draft-UI gates read
  `pendingSessionContext ?? connection.sessionContext`, and the pending
  state is cleared only after create-and-attach completes successfully. A
  failed attempt leaves the pending standalone intent (and its error)
  visible for retry.
- `loadSidebarSession` / `switchWorkspace` (`App.tsx:8703`) overwrite the
  pending context with the loaded session's explicit context.
- The provider's own deferred path (`shouldDeferInitialSessionCreation`)
  keeps working unchanged underneath.

## Recents and Lifecycle Actions

- Add a top-level **Recents** group in the sidebar
  (`components/sidebar/WebShellSidebar.tsx`). No cross-context list exists
  today: `useScopedSessions` / `useWebShellSessions`
  (`session-catalog/session-catalog-hooks.ts`) are keyed by
  `SessionCatalogQuery { routeKind, workspaceCwd }`
  (`session-catalog/session-catalog-store.ts:11`) — workspace-scoped by
  construction. PR6 adds a standalone catalog lane fed by
  `listStandaloneSessionsPage` (cursor pagination, `archiveState` filter)
  rather than forcing standalone rows through the workspace catalog store.
  Live sessions and project sessions keep their existing groups; standalone
  children (sub-sessions with `parentSessionId`) never appear.
- **The internal Conversations cwd never leaks through Recents** (review
  P2). Standalone summaries retain an internal `workspaceCwd` for protocol
  routing, and the existing session-details row renders `workspaceCwd` as a
  project folder. Recents rows therefore use a standalone-specific view
  model that drops `workspaceCwd` entirely, and a standalone-specific
  action dispatch that never passes it to project details, navigation, or
  workspace resolvers.
- Per-session actions reuse the existing
  `WebShellSidebarSessionActionItem` menu pattern
  (`WebShellSidebar.tsx:270`: details | rename | export | delete | pin |
  archive) but dispatch to the standalone SDK routes: **rename**
  (`renameStandaloneSession`), **export** (`exportStandaloneSession`),
  **archive** / **unarchive** (batch routes), **delete**
  (`deleteStandaloneSessions`). Workspace-only actions (pin, group) are not
  offered on standalone rows.
- Delete retains the existing second-confirmation dialog pattern
  (`DeleteSessionDialog`) and states that the transcript and private files
  are removed. On success the session leaves Recents even when the response
  carries `fileCleanupPending`; that subset is surfaced as a non-blocking
  notice, not a blocking error.
- **Archived standalone sessions stay reachable** (review P2): the lazy
  Archived section gains a standalone `archiveState=archived` lane — today
  that section is backed by workspace catalogs only, while the umbrella
  contract requires archived standalone sessions to remain visible. Because
  PR5 deliberately skips workspace event invalidation for standalone
  contexts, the standalone lanes refresh explicitly after create, prompt
  completion, and every lifecycle action.
- **Batch outcomes are interpreted per session id** (review P2): archive,
  unarchive, and delete return partial-success envelopes even with HTTP 200. The catalog updates only when the target id appears in
  `archived`/`alreadyArchived`, `unarchived`/`alreadyActive`, or
  `removed`/`notFound` as appropriate; an id in `errors` keeps its row and
  surfaces the per-session code/message. `fileCleanupPending` is only an
  additional notice for an otherwise removed id.

## Project-Only Surface Hiding

In a standalone (or Live) chat, hide: workspace/project selector, Git
status/branch/worktree controls, project file browser, project settings,
pin/group controls, and attachments/uploads (standalone MVP excludes
uploads). Model, approval, tool, permission, transcript, and supported
metadata controls remain.

- Gate on the effective context (`pendingSessionContext ??
connection.sessionContext`) so draft standalone chats hide project
  surfaces before the session exists — never on the presence of a cwd. The
  established pattern to extend is `ordinaryWorkspaces` /
  `isKnownLiveWorkspaceCwd` (`App.tsx:2401-2405`), which already hides
  project UI for the Live runtime; PR6 generalizes it to "current chat is
  not a workspace context".
- Component list (`origin/main`): composer workspace selector
  (`components/WorkspaceSelector.tsx`, rendered `ChatEditor.tsx:3116`);
  Git chips/popovers (`GitBranchIndicator`, `GitModePopover`,
  `BranchPickerPopover`, gated by `gitBranchVisible`,
  `ChatEditor.tsx:2435`); Git dialogs (`GitDialog` et al.); project
  settings panel (`openPanel('settings')` + workspace-scoped
  `useSettings`); @-mention file browser (`components/AtMentionPanel.tsx`,
  `hooks/useAtMentionMenu.ts`); pin/group controls
  (`SESSION_ORGANIZATION_FEATURE` sidebar grouping).
- Uploads have two lanes, both hidden in the standalone MVP: (1) workspace
  file upload — `hooks/useFileUpload.ts` → `client.uploadWorkspaceFile`,
  rendered via `composer/AddMenu.tsx` and the @-panel "Upload file" item,
  already kill-switched by `fileUploadEnabled` and the
  `workspace_file_upload` capability (`ChatEditor.tsx:1585-1588`); (2)
  inline prompt attachments — pasted/dropped images and text files in
  `useComposerCore.ts` (`pastedImages`/`pastedFiles`, :1718-1719). The
  acceptance matrix keeps all attachments out of standalone MVP; lane 2 is
  session-scoped, so it needs an explicit context check, not a capability
  check.
- **Attachments held across a context switch are dropped, not carried**
  (review P1): hiding paste/drop/upload controls does not clear
  `pastedImages`/`pastedFiles` already held by `useComposerCore`, and
  `createNewSession` does not clear them either — files added in a
  workspace could otherwise ride into the first standalone prompt.
  Switching into a standalone draft clears held attachments with a visible
  notice, and a submit-time non-workspace guard blocks stale or
  programmatically supplied attachments from reaching a standalone session.
- Live chats get the same treatment through the same gate; PR5 already
  skips workspace providers/skills/Git/preheat for non-workspace contexts
  inside the provider, so this PR only hides the visible controls.

## Deep Links

There is no router library: `main.tsx` + `utils/sessionPath.ts` own the
`/session/<id>?workspace=<workspaceId>` scheme (`getSessionIdFromUrl` /
`getWorkspaceIdFromUrl`, `main.tsx:83-87`;
`parseSessionId`/`buildSessionPathname`), and the App reports context
upward through `onSessionIdChange` (`App.tsx:8282`) so `main.tsx` can
`replaceState` the URL.

- New standalone links carry an explicit context parameter:
  `/session/<id>?context=standalone` (no `?workspace=`). UUIDs are reserved
  daemon-wide, so a context-tagged link can never collide with a workspace
  session. Legacy context-free links keep today's workspace resolution —
  standalone sessions did not exist before this feature, so no migration is
  needed.
- A `context=standalone` cold load resolves only after the standalone read
  path is ready, and then only through exact `getStandaloneSession`
  semantics: a summary loads the session, not-found shows the existing
  missing-session UI (`connection.missingSession` →
  `showMissingSessionState`). It never guesses the primary workspace.
- **A `creating` lookup must reach a terminal state** (review P2): the
  resolver polls exact lookup with bounded backoff (e.g. up to 30 s, capped
  attempts) and then stops at an explicit **Retry** action; it never hangs
  in the resolving state forever.
- **Stale resolution is canceled before it starts a load** (review P1):
  the provider's generation guard only orders loads after they start, but
  exact lookup and polling happen before `loadSession`, so a delayed
  `creating` poll resolving after the user opened another session would
  start a load that incorrectly wins. An App-level route-resolution token
  is invalidated on every navigation and checked before each poll and
  immediately before `loadSession`.
- **Fail-closed edge cases** (review P2): a `?context=standalone` link
  carrying a conflicting `?workspace=` parameter is rejected, not
  reconciled; on a daemon without the capability, a standalone link shows
  the "requires a daemon upgrade" state instead of resolving anywhere; on a
  capable daemon whose Conversations runtime is unavailable (`503`), the
  structured error is shown with retry.
- `onSessionIdChange` becomes context-aware: standalone sessions report
  `context=standalone` and drop `workspaceId`; workspace and Live links
  keep their existing resolvers. PR5's switching semantics already
  serialize cross-context commits, so a late-arriving resolution cannot
  overwrite a newer target.

## Standalone State Surfacing

Render the typed PR5 state instead of parsing strings:

- `standaloneSession.workingDirectory.state === 'recreated'` → warning that
  the transcript survived but previous files were not recovered.
- `standaloneSession.errorCode === 'working_directory_missing'` → offer
  explicit **repair** (`repairStandaloneSessionDirectory`); repair never
  replays a prompt. This requires one small provider/App transition in PR6
  scope (review P1): today `sendPrompt`'s catch surfaces the
  prompt-admission `409` only as a generic notice and never copies its
  typed code into `standaloneSession`, and the SDK repair call neither
  clears provider error state nor reloads the session — so the Repair UI
  could neither reliably appear nor reliably unblock. PR6 captures the
  typed code into `standaloneSession.errorCode` on prompt-admission
  rejection, owner-guards Repair to the affected session, and on success
  reloads the same standalone session, clearing the error only after the
  reload commits.
- `standaloneSession.errorCode === 'working_directory_compromised'` →
  **fail-closed blocking state** (review P1): the service rejects an
  existing compromised path instead of recreating it, so no Repair action
  is offered — the user gets terminal guidance (export the transcript,
  delete the session) instead.
- `standaloneSession.creationRecovery` → outcome-unknown banner exposing
  the reserved UUID with a "check status" retry that performs exact lookup,
  plus a terminal error path when lookup reports not-found.
- Delete responses carrying `fileCleanupPending` → non-blocking notice that
  file cleanup will finish automatically; the transcript is already gone.

## Compatibility and Rollout

- No daemon or SDK change; PR6 is UI-only against the merged v1 contract.
- Old daemon → legacy primary behavior everywhere; old WebShell against a
  new daemon → unchanged (it never calls standalone routes).
- Post-#9811, the provider and the product UI live in the same package, so
  no cross-package release-ordering caveat applies.

## Verification

Unit/component (vitest, `packages/web-shell`):

- Entry-point → context mapping for every row of the routing table,
  including current-session inheritance (workspace, standalone) and Live
  routing through `startLive('new')`.
- Standalone creation request body asserted exactly: no `workspaceCwd`,
  `sourceType`, `worktree`, or `branch` (review P1); workspace creation
  keeps them.
- Capability tri-state: loading creates nothing in any context;
  loaded-absent takes the legacy path with zero standalone requests
  (assertable via the e2e `mockDaemon` request log); load error fails
  closed with retry (review P1).
- Capable-daemon creation failure → error rendered, **pending standalone
  intent retained** and still authoritative for gates, no primary-workspace
  create issued (review P1).
- Recents list/rename/export/archive/unarchive/delete flows, child
  exclusion, `fileCleanupPending` removal semantics, and the standalone
  view model never exposing the internal cwd to details/navigation
  (review P2).
- Surface hiding per effective context — including the draft standalone
  chat before first prompt; uploads unavailable in standalone.
- Deep links: `creating` polls to a terminal state and stops at Retry;
  conflicting `?workspace=` + `context=standalone` rejected; incapable
  daemon shows upgrade state; not-found shows the missing-session UI
  (review P2).
- `recreated` warning, repair offered only for `working_directory_missing`,
  `working_directory_compromised` rendered fail-closed without a repair
  action (review P1), creation-recovery banner rendering from typed state.
- Prompt-admission `working_directory_missing` reaches
  `standaloneSession.errorCode`, Repair is owner-guarded to the affected
  session, and success reloads the same session and clears the error
  (review P1).
- A delayed `creating` poll canceled by a user session switch never starts
  a load (review P1).
- Context switch clears held composer attachments with a visible notice;
  the submit-time guard rejects stale or programmatic attachments
  (review P1).
- Archived standalone lane lists and refreshes after lifecycle actions;
  partial-success batch envelopes handled per action (review P2).

E2E (Playwright, `packages/web-shell/client/e2e`):

- Extend `utils/mockDaemon.ts` scenario with a
  `standalone_sessions_v1` capability toggle and the standalone route
  family; add `web-shell.standalone.spec.ts` covering: Home New Chat →
  standalone create body asserted; project New Chat → workspace create;
  Recents lifecycle; capability loading/absent/error states; capable-daemon
  failure with retained intent.
- Manual E2E plan recorded at
  `.qwen/e2e-tests/2026-08-29-webshell-standalone-chats.md` and dry-run
  against a real `qwen serve` daemon before merge, per repo workflow.

Commands: `cd packages/web-shell && npx vitest run <file>` for focused
tests, `npm run verify` (lint + format:check + typecheck + test:ci) and
`npm run test:e2e`, then root `npm run build && npm run typecheck`.

## Scope Boundary

PR6 does not add: standalone attachments/uploads (waits on the workspace
upload follow-up), moving/forking a standalone session into a project,
durable standalone scheduling, storage quotas, or child-session management
UI. `SessionOverviewPanel` and `ResumeDialog` remain workspace-scoped in
this PR; the top-level Recents group lives in the sidebar only. Split View
stays workspace-only (context-bearing pane descriptors are a follow-up).
The one in-scope provider change is the prompt-admission error-code capture
plus repair-and-reload transition, because the Repair UI depends on it; any
other typed gap discovered in the provider surface is raised as a
follow-up. It does not change daemon lifecycle behavior, the SDK contract,
or the PR5 provider switching semantics.
