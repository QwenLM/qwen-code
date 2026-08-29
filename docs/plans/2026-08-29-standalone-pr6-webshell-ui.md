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

This PR touches `packages/web-shell` (product UI) and, only where a typed
hole is found, `packages/webui` (PR5 provider surface). It adds no daemon
route and no SDK method.

Suggested title: `feat(web-shell): Add standalone chats`.

## Merged Contract This PR Consumes

Verified against `origin/main` (PR3 `34a6e918b6`, PR4 `7357136dd1`, PR5
`ac761e11c2`).

### Daemon (packages/cli/src/serve)

- Routes registered by `registerStandaloneSessionRoutes`
  (`routes/standalone-sessions.ts:247`):
  `POST/GET /standalone/sessions`, `GET /standalone/sessions/:id`,
  `POST .../load`, `POST .../resume`, `POST .../repair-directory`,
  `PATCH .../metadata`, `GET .../export`, `POST .../archive`,
  `POST .../unarchive`, `POST .../delete`.
- Capability `standalone_sessions_v1` advertised from
  `capabilities.ts:136` only when the full dependency set is installed.

### SDK (packages/sdk-typescript/src/daemon)

- `STANDALONE_SESSIONS_CAPABILITY = 'standalone_sessions_v1'`
  (`standalone-sessions.ts:16`).
- `DaemonClient`: `createStandaloneSession` (generates the UUID, wraps
  response loss into `DaemonStandaloneCreationOutcomeUnknownError` carrying
  `sessionId` + exact-lookup `recovery`, never auto-retries),
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

### WebUI provider (packages/webui/src/daemon/session)

- `DaemonProductSessionContext` (`types.ts:71`):
  `{ kind: 'workspace'; cwd } | { kind: 'standalone' } | { kind: 'live' }`.
- `DaemonSessionProviderProps.sessionContext` (types.ts:160) alongside
  legacy `workspaceCwd`; conflicts throw before any request.
- Actions `createSession` / `loadSession` / `resumeSession` accept
  `options.sessionContext` (types.ts:438-471). Standalone create is not
  retried and is exempt from the generic 30 s action timeout; Live create is
  rejected by this provider.
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

Implementation map (`packages/web-shell/client`, line numbers from
`origin/main`; `packages/web-shell` currently has zero `sessionContext`
references and passes legacy `workspaceCwd` everywhere):

- **Home / global New Chat** — sidebar primary nav `handleNewSession()`
  (`components/sidebar/WebShellSidebar.tsx:5084-5103`) →
  `createNewSession()` (`App.tsx:8543`). Today this only clears; creation is
  lazy. With capability, it sets pending context `{ kind: 'standalone' }`.
  The Home first-prompt path (`ensureSessionForPrompt`, `App.tsx:6095`,
  target-cwd resolution at `6126-6140` →
  `utils/sessionPreparation.ts#createAndAttachSessionForPrompt`) consumes
  the pending context instead of resolving locked/selected/primary cwd.
- **Project-scoped New Chat** — `handleNewSession(wsCwd)`
  (`WebShellSidebar.tsx:5509-5514`) → `createNewSession(workspaceCwd)`;
  unchanged, pending context `{ kind: 'workspace', cwd }`.
- **Goals** — `onCreateGoal` (`App.tsx:13080-13142`) allocates through
  `createNewSession(undefined, { keepView: true })` +
  `ensureSessionForPrompt`; stays workspace-bound (locked/selected/primary
  cwd), ignoring any standalone pending context.
- **Git** — `resolveSessionForWorkspace` (`App.tsx:6574-6614`) and the
  composer git chips (`gitModeIntent`, `App.tsx:6060`, gated by
  `gitModeEligible` at `6679-6681`); stays workspace-bound.
- **Current-session New Chat** — `createNewSession()` inherits the active
  `connection.sessionContext`: standalone → pending standalone, workspace →
  pending workspace with the current cwd (today's behavior). A Live current
  session maps to pending **standalone** (open decision, reviewer
  confirmation requested): the provider deliberately does not create Live
  sessions, and a fresh text chat from a voice session is projectless like
  standalone — strict "inherit" would require Live creation the provider
  rejects.
- **Split view** — each pane owns a `DaemonSessionProvider`
  (`components/SplitView.tsx`, pane keying at :234-247); panes receive the
  pane's explicit context alongside `sessionId` so a standalone chat can be
  opened beside a workspace chat without cross-contamination.
- **Context propagation** — `WorkspaceSessionProvider`
  (`components/WorkspaceSessionProvider.tsx`) still passes legacy
  `workspaceCwd` into `DaemonSessionProvider`; PR6 passes the resolved
  `sessionContext` prop instead (the provider normalizes legacy cwd at its
  compatibility boundary, so both forms remain valid during the cutover).
- **Loading existing sessions** — `loadSidebarSession` (`App.tsx:9016`)
  currently passes `{ workspaceCwd }`; for standalone entries it calls
  `loadSession(id, { sessionContext: { kind: 'standalone' } })`.

Legacy callers that pass only `workspaceCwd` keep today's behavior
untouched.

## Capability Dual Behavior

- Read the capability from `useWorkspace().capabilities.features` —
  `DaemonWorkspaceProvider` fetches `client.capabilities()` once at
  startup, before any session exists, so entry points (which fire before a
  session) must not rely on the session-scoped `connection.capabilities`.
  Compare against `STANDALONE_SESSIONS_CAPABILITY` from
  `@qwen-code/sdk/daemon`.
- **Capability absent** (old daemon): preserve legacy behavior — global New
  Chat targets the primary workspace. Do not call any standalone route. An
  informational hint that standalone chats need a daemon upgrade is allowed.
- **Capability present, creation fails**: display the structured error and
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
  above and cleared on consume. Pending context is a
  `DaemonProductSessionContext`, never a bare `undefined` cwd — "no cwd
  yet" is not standalone semantics.
- `ensureSessionForPrompt` (`App.tsx:6095`) prefers the pending context:
  `{ kind: 'standalone' }` → `createSession({ sessionContext })`; a
  workspace pending context → today's exact-cwd path; none → legacy
  locked/selected/primary resolution.
- Switching away and back before first prompt retains the pending context
  verbatim; `loadSidebarSession` / `switchWorkspace` (`App.tsx:8605`)
  overwrite it with the loaded session's explicit context.
- The provider's own deferred path (`shouldDeferInitialSessionCreation`,
  webui) keeps working unchanged underneath.

## Recents and Lifecycle Actions

- Add a top-level **Recents** group in the sidebar
  (`components/sidebar/WebShellSidebar.tsx`). No cross-context list exists
  today: `useScopedSessions` / `useWebShellSessions`
  (`session-catalog/session-catalog-hooks.ts`) are keyed by
  `SessionCatalogQuery { routeKind, workspaceCwd }`
  (`session-catalog/session-catalog-store.ts:9-13`) — workspace-scoped by
  construction. PR6 adds a standalone catalog lane fed by
  `listStandaloneSessionsPage` (cursor pagination, `archiveState` filter)
  rather than forcing standalone rows through the workspace catalog store.
  Live sessions and project sessions keep their existing groups; standalone
  children (sub-sessions with `parentSessionId`) never appear.
- Per-session actions reuse the existing
  `WebShellSidebarSessionActionItem` menu pattern
  (`WebShellSidebar.tsx:270-284`: details | rename | export | delete | pin
  | archive) but dispatch to the standalone SDK routes:
  **rename** (`renameStandaloneSession`), **export**
  (`exportStandaloneSession`), **archive** / **unarchive** (batch routes),
  **delete** (`deleteStandaloneSessions`). Workspace-only actions (pin,
  group) are not offered on standalone rows.
- Delete retains the existing second-confirmation dialog pattern
  (`DeleteSessionDialog`) and states that the transcript and private files
  are removed. On success the session leaves Recents even when the response
  carries `fileCleanupPending`; that subset is surfaced as a non-blocking
  notice, not a blocking error.

## Project-Only Surface Hiding

In a standalone (or Live) chat, hide: workspace/project selector, Git
status/branch/worktree controls, project file browser, project settings,
pin/group controls, and attachments/uploads (standalone MVP excludes
uploads). Model, approval, tool, permission, transcript, and supported
metadata controls remain.

- Gate on `connection.sessionContext?.kind` from the provider — the same
  value that drove routing — never on the presence of a cwd. The
  established pattern to extend is `ordinaryWorkspaces` /
  `isKnownLiveWorkspaceCwd` (`App.tsx:2330-2338`), which already hides
  project UI for the Live runtime; PR6 generalizes it to
  "current chat is not a workspace context".
- Component list (`origin/main`): composer workspace selector
  (`components/WorkspaceSelector.tsx`, rendered `ChatEditor.tsx:3087`);
  Git chips/popovers (`GitBranchIndicator`, `GitModePopover`,
  `BranchPickerPopover`, `ChatEditor.tsx:3119-3154`, gated by
  `gitBranchVisible` / `gitModeEligible`); Git dialogs (`GitDialog` et al.,
  `App.tsx:12143`); project settings panel (`openPanel('settings')` +
  workspace-scoped `useSettings`); @-mention file browser
  (`components/AtMentionPanel.tsx`, `hooks/useAtMentionMenu.ts`); pin/group
  controls (`SESSION_ORGANIZATION_FEATURE` sidebar grouping).
- Uploads have two lanes, both hidden in the standalone MVP: (1) workspace
  file upload — `hooks/useFileUpload.ts` → `client.uploadWorkspaceFile`,
  rendered via `composer/AddMenu.tsx` and the @-panel "Upload file" item,
  already kill-switched by `fileUploadEnabled` and the
  `workspace_file_upload` capability (`ChatEditor.tsx:1557-1586`); (2)
  inline prompt attachments — pasted/dropped images and text files in
  `useComposerCore.ts` (`pastedImages`/`pastedFiles`, :1711-1714). The
  acceptance matrix keeps all attachments out of standalone MVP; lane 2 is
  session-scoped, so it needs an explicit context check, not a capability
  check.
- Live chats get the same treatment through the same gate; PR5 already
  skips workspace providers/skills/Git/preheat for non-workspace contexts
  inside the provider, so this PR only hides the visible controls.

## Deep Links

There is no router library: `main.tsx` + `utils/sessionPath.ts` own the
`/session/<id>?workspace=<workspaceId>` scheme
(`parseSessionId`/`buildSessionPathname`), and the App reports context
upward through `onSessionIdChange(connection.sessionId, workspaceId,
reportedWorkspaceCwd)` (`App.tsx:8156-8196`) so `main.tsx` can
`replaceState` the URL.

- New standalone links carry an explicit context parameter:
  `/session/<id>?context=standalone` (no `?workspace=`). UUIDs are reserved
  daemon-wide, so a context-tagged link can never collide with a workspace
  session. Legacy context-free links keep today's workspace resolution —
  standalone sessions did not exist before this feature, so no migration is
  needed.
- A `context=standalone` cold load resolves only after the standalone
  read path is ready, and then only through exact `getStandaloneSession`
  semantics: `creating` shows a resolving state, a summary loads the
  session, not-found shows the existing missing-session UI
  (`connection.missingSession` → `showMissingSessionState`). It never
  guesses the primary workspace.
- `onSessionIdChange` becomes context-aware: standalone sessions report
  `context=standalone` and drop `workspaceId`; workspace and Live links
  keep their existing resolvers. PR5's switching semantics already
  serialize cross-context commits, so a late-arriving resolution cannot
  overwrite a newer target.

## Standalone State Surfacing

Render the typed PR5 state instead of parsing strings:

- `standaloneSession.workingDirectory.state === 'recreated'` → warning that
  the transcript survived but previous files were not recovered.
- `standaloneSession.errorCode` → `working_directory_missing` /
  `working_directory_compromised` → offer explicit **repair**
  (`repairStandaloneSessionDirectory`); repair never replays a prompt.
- `standaloneSession.creationRecovery` → outcome-unknown banner exposing the
  reserved UUID with a "check status" retry that performs exact lookup, plus
  a terminal error path when lookup reports not-found.
- Delete responses carrying `fileCleanupPending` → non-blocking notice that
  file cleanup will finish automatically; the transcript is already gone.

## Compatibility and Rollout

- No daemon or SDK change; PR6 is UI-only against the merged v1 contract.
- Old daemon → legacy primary behavior everywhere; old WebShell against a
  new daemon → unchanged (it never calls standalone routes).
- `@qwen-code/webui` already re-exports the standalone types through
  `daemon-react-sdk`; if WebShell imports SDK standalone methods directly,
  align the SDK peer minimum with the first release containing PR4 (same
  caveat PR5 recorded).

## Verification

Unit/component (vitest):

- Entry-point → context mapping for every row of the routing table,
  including current-session inheritance of each kind.
- Capability absent → legacy path, zero standalone requests issued
  (assertable via the e2e `mockDaemon` request log and unit-level SDK
  mocks).
- Capable-daemon failure → error rendered, pending standalone intent
  retained, no primary-workspace create issued.
- Recents list/rename/export/archive/unarchive/delete flows, child
  exclusion, `fileCleanupPending` removal semantics.
- Surface hiding per context kind; uploads unavailable in standalone.
- Deep-link resolution ordering (catalog readiness) and not-found UI.
- `recreated` warning, repair offer, creation-recovery banner rendering
  from the typed connection state.

E2E (Playwright, `packages/web-shell/client/e2e`):

- Extend `utils/mockDaemon.ts` scenario with a
  `standalone_sessions_v1` capability toggle and the standalone route
  family; add `web-shell.standalone.spec.ts` covering: Home New Chat →
  standalone create body asserted; project New Chat → workspace create;
  Recents lifecycle; old-daemon fallback; capable-daemon failure.
- Manual E2E plan recorded at
  `.qwen/e2e-tests/2026-08-29-webshell-standalone-chats.md` and dry-run
  against a real `qwen serve` daemon before merge, per repo workflow.

Commands: `cd packages/webui && npx vitest run <file>`, `cd
packages/web-shell && npm run verify` (lint + format:check + typecheck +
test:ci) and `npm run test:e2e`, then root `npm run build && npm run
typecheck`.

## Scope Boundary

PR6 does not add: standalone attachments/uploads (waits on the workspace
upload follow-up), moving/forking a standalone session into a project,
durable standalone scheduling, storage quotas, or child-session management
UI. `SessionOverviewPanel` and `ResumeDialog` remain workspace-scoped in
this PR; the top-level Recents group lives in the sidebar only. It does not
change daemon lifecycle behavior, the SDK contract, or the PR5 provider
switching semantics; any typed gap discovered in the PR5 surface is raised
as a follow-up rather than patched into this PR's UI work.
