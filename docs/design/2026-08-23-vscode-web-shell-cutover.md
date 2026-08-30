# Complete the VS Code Web Shell cutover

Status: Draft

Depends on [#9719](https://github.com/QwenLM/qwen-code/pull/9719).

## Goal

Make the VS Code companion use Web Shell for the complete chat experience, not
only the transcript. Web Shell owns the visible chat UI and its interaction
state, and the extension host keeps the VS Code integrations: process
lifecycle, authentication, workspace trust, diff editors, and the contributed
commands.

This is the first of two follow-up changes. The second change removes the
remaining repository consumers and deletes `packages/webui`.

## Current state

PR #9719 replaces the legacy VS Code message timeline with
`WebShellTranscript`, but the companion remains a hybrid UI:

- 15 production source files in the VS Code companion still import
  `@qwen-code/webui`.
- The composer, completion menu, permission drawer, Ask User Question dialog,
  session selector, header, onboarding, image preview, model controls, icons,
  shared types, and utility functions still come from `packages/webui`.
- 69 production source files in Web Shell import
  `@qwen-code/webui/daemon-react-sdk`.
- `@qwen-code/web-shell` declares `@qwen-code/webui` as both a peer dependency
  and a development dependency.

`WebShellWithProviders` expects the daemon HTTP/SSE runtime, while the
extension owned an ACP connection and exchanged messages with the webview
through `postMessage`.

## Decisions

### Run the chat on a workspace-scoped daemon

This work first built a controlled host entry point driven by the ACP bridge
over `postMessage`. That entry point reimplemented, against a second protocol,
state Web Shell already derives from the daemon — transcript, streaming,
permissions, questions, session history — and the reimplementation is what kept
regressing. The chat now runs on `WebShellWithProviders` instead.

The extension spawns `qwen serve` on a loopback port bound to the workspace,
with `--require-auth` and a per-process token passed through the environment,
and hands the webview its base URL. The webview talks to that daemon directly;
Web Shell's own session, transcript, and permission machinery is the single
implementation.

The ACP connection remains, but its role narrows to authentication state and
the `/auth` flow. It no longer carries prompts.

Consequences worth stating plainly:

- The extension runs two Qwen processes per workspace: the ACP agent for auth
  and the daemon for the conversation.
- The daemon is shared with the CLI and the browser Web Shell for that
  workspace, so sessions the companion creates carry the `vscode` source type
  and its history is scoped to that source. Without it the panel would list
  conversations the user started in a terminal.
- A daemon is bound to one workspace at spawn, so a multi-root window respawns
  it when the active root changes.
- Turn-lifecycle features that were driven by ACP agent events — the editor tab
  status dot and the long-task/attention notifications — no longer fire, and
  `/insight` progress no longer reaches the host. Web Shell renders its own
  insight cards. Restoring the tab dot and notifications needs the webview to
  report turn and permission transitions to the host; that is not in this
  change.

### Use Web Shell's standard entry point

The companion mounts `WebShellWithProviders` and customizes it through props
rather than through a bespoke embedded component: composer toolbar actions,
host-only slash entries, active-editor context injection, review-diff and
insight-report open handlers, and the session source type. The VS Code chrome
the daemon cannot supply — the view header, session history dropdown,
onboarding, and account dialog — stays in the extension and is themed from VS
Code tokens and localized from the same language signal Web Shell uses.

The host contract covers these existing capabilities:

| State supplied by the host                       | Actions sent to the host                    |
| ------------------------------------------------ | ------------------------------------------- |
| Active session and session summaries             | Submit and cancel a prompt                  |
| Transcript blocks and streaming state            | Create or switch session                    |
| Pending permission and question requests         | Respond to permission or question           |
| Models, approval mode, commands, and skills      | Change model or approval mode               |
| Context usage, authentication, and account state | Request completion and authentication       |
| Workspace files and pasted images                | Open a file, diff, report, or external link |

The contract is owned by `@qwen-code/web-shell`; it is not a new workspace
package and it does not introduce another shared `Message[]` model. Transcript
data continues to use the canonical SDK `DaemonTranscriptBlock[]` contract.

### Make Web Shell self-contained

The daemon React providers and hooks currently stored under
`packages/webui/src/daemon` belong to the Web Shell runtime integration. They
move under `packages/web-shell` and Web Shell stops importing or declaring
`@qwen-code/webui`.

If the low-level provider API must remain available to external Web Shell
embedders, it will be exported from a Web Shell subpath. It will not be moved
to a new package. The batteries-included `WebShellWithProviders` entry remains
the preferred daemon integration.

### Delete replaced VS Code code in the same change

The cutover is not complete while two implementations remain. When the
controlled Web Shell surface owns a capability, the corresponding companion
component, hook, state branch, compatibility re-export, style import, and test
is removed in the same PR.

The extension may keep code only when it is a real VS Code host capability,
such as opening files, showing native diffs, reading the active editor,
workspace file search, clipboard integration, or extension lifecycle.

## Scope

The PR completes and verifies these user flows:

- onboarding and authenticated empty states;
- start, cancel, and resume a conversation;
- streaming assistant text and expandable thought;
- all tool-call states and plan rendering;
- Bash/Edit permissions, including every response option;
- Ask User Question, including multi-question answers;
- history opening, session selection, new session, and late-frame isolation;
- composer input, slash commands, file completion, skills, images, and active
  editor context;
- approval mode, model selection, thinking mode, context usage, and account
  access;
- copy actions, file links, report links, and VS Code diff actions;
- error, cancellation, authentication, and reconnect states.

The latest user message remains editable. The host maps the selected transcript
turn to a daemon rewind snapshot and rewinds the session before resubmitting.

## Out of scope

- Removing the ACP connection entirely; it still owns authentication.
- Restoring the tab status dot, completion notifications, and host-side
  `/insight` progress on daemon turn events.
- Migrating desktop-specific navigation or native window chrome.
- Creating `@qwen-code/chat-panel`, another UI package, or a parallel message
  model.
- Deleting `packages/webui`; that is the dependent cleanup PR.
- Deleting `packages/desktop/apps/webui`, which is a separately named desktop
  application and is not the legacy shared package targeted here.

## Implementation sequence inside this PR

1. Relocate the daemon React layer into Web Shell and update its internal
   imports, build aliases, public entry points, tests, and README.
2. Spawn a workspace-scoped daemon from the extension host and bootstrap the
   webview with its base URL, token, and client id.
3. Mount `WebShellWithProviders` against that daemon and add the props the
   companion needs, including its session source type.
4. Remove replaced companion components, hooks, compatibility utilities,
   WebUI styles, Tailwind preset usage, package dependency, and bundler
   exceptions.
5. Add an import gate proving neither `packages/web-shell` nor
   `packages/vscode-ide-companion` depends on `@qwen-code/webui`.

These are implementation steps within one review unit, not separate PRs.

## Verification gate

### Automated

- Web Shell unit, DOM, typecheck, lint, and library build checks.
- VS Code companion unit, typecheck, lint, and production bundle checks.
- Contract tests for every host state/action mapping.
- Session-switch tests that reject updates belonging to the previous session.
- A repository check that rejects new WebUI imports in Web Shell and VS Code.

### Real VS Code UI E2E

Run the built extension in one real VS Code Extension Development Host using a
stable test profile. Launch that host once and reuse it for the full matrix
instead of restarting VS Code per case. The dedicated profile avoids modifying
the user's normal editor process, must dismiss onboarding without requiring
GitHub or Copilot sign-in, and must preserve its extension state between cases.

Capture screenshots for:

1. dark and light transcript parity;
2. composer with file, slash-command, skill, and image attachments;
3. permission request before and after a response;
4. Ask User Question before and after submission;
5. history selector and session switch;
6. pending, running, completed, failed, and cancelled tool calls;
7. streaming thought/text and cancellation;
8. model and approval-mode controls;
9. authentication, empty, error, and reconnect states.

The PR test report must distinguish WebView-only assertions from actions whose
VS Code host or daemon side effect was observed end to end.

## Completion criteria

- VS Code mounts Web Shell for the entire chat flow.
- Companion-created sessions are attributable to the `vscode` source and the
  panel's history lists only them.
- Web Shell and VS Code contain no production import of `@qwen-code/webui`.
- The Web Shell package has no peer, development, build, or Vite dependency on
  `@qwen-code/webui`.
- Replaced companion UI and interaction code is deleted.
- All listed real-host E2E flows have assertions and screenshot evidence.
- Remaining repository references to `packages/webui` are enumerated in the
  dependent deletion PR.
