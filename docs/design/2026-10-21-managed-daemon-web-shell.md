# Unified local daemon and Managed WebShell

[English](2026-10-21-managed-daemon-web-shell.md) | [简体中文](2026-10-21-managed-daemon-web-shell.zh-CN.md)

Status: unified startup and shared workspace navigation implemented; native macOS arm64 acceptance uses a deterministic model. Date: 2026-10-21.

## Problem and scope

Before this change, the local launcher in #14928 started Java, a private Hosted Harness and a
Managed-only WebShell. Users also need the ordinary daemon's Local sessions in
the same application, started with one command. The existing WebShell already
supports Local and Managed navigation when supplied with a Java provider.

`qwen serve --managed --open` supervises the ordinary daemon, Java and the
private Harness, exposing one authenticated loopback origin. Ordinary
`qwen serve` keeps its current behavior. Runtime installation, H2 persistence,
Managed Workspace ownership and existing recovery constraints remain in force.

## Implementation

The launcher waits for Java and Harness readiness and creates the default
Managed Workspace before starting the ordinary daemon through `runQwenServe`.
The daemon uses its normal current-directory Workspace and persistent public
bearer. Its built-in HTTP, SSE and WebSocket transports remain the sole owner of
ordinary Session, terminal, voice and workspace routes. This avoids adding a
second proxy for the daemon's transport and security boundaries.
The ordinary ACP child starts on the first Local use, rather than preheating
while application readiness is being reported. This avoids an initialization
shutdown race for a user who starts and immediately stops the application, and
does not create an unused Local model process for Managed-only work.

The launcher's private dependency configuration mounts the existing Managed
boot and signed Java proxy routes after daemon authentication and before JSON
body parsing. `/managed/boot` is process-scoped. The Java WebShell and exact
artifact-content routes retain Java tenant, actor, Workspace and Session
authorization. They never fall back to ordinary daemon handlers. `/capabilities`
returns the actual daemon envelope. Internal Java, writer, Broker and maintenance
routes remain private.

The server-owned HTML marker enables authenticated same-origin Managed boot.
The browser constructs the existing Java provider using only validated public
boot values and the public bearer, and supplies it to the normal standalone
WebShell. A shared workspace navigation controls both kinds of Session.
Caller-supplied daemon targets, identity fields and Java endpoints cannot change
the Managed provider. Managed URL restoration must not be blocked by stale Local
Workspace or Session navigation parameters.

The launcher owns process signals; embedded daemon signal handlers are disabled
for this caller. Shutdown closes daemon admission and transports before stopping
Java and Harness. An unexpected daemon listener close or owned child exit ends
the application with a nonzero result. Failed startup cleans up owned services
and releases the private data lock. Existing durable worker ownership survives.

## Shared workspace navigation

The Local/Managed execution tabs are removed. Ordinary and Managed workspaces appear in the existing Projects navigation, with Managed workspaces labelled Managed. Each workspace contains its own sessions. Selecting a session selects its existing provider; creating a task from a workspace uses that workspace's provider. The top New task action follows the selected conversation or draft. Ordinary workspaces, projectless sessions and their existing actions remain available while a Managed conversation is open.

The sidebar provides an internal slot inside the existing workspace list. The Managed page keeps its single session catalog, pagination and refresh lifecycle and projects its navigation into this slot. The slot receives the common search text. Managed workspace discovery uses the existing provider's workspace binding API; no Java, SDK protocol or daemon route changes are required. Workspace and session identity retain the provider storage key and server IDs. A Managed workspace is never represented by an ordinary daemon cwd, even if display names or IDs match.

Managed workspace selection feeds the existing creation component, retaining its workspace validation, edited-directory confirmation, pending-command recovery and authorization checks. An explicit workspace that cannot admit sessions stays unavailable; it cannot silently select another workspace or the ordinary primary. New workspaces and sessions refresh the shared catalog. Pagination remains explicit for both Managed workspace discovery and the globally paged Managed session list. Sessions whose workspace is not on the current workspace page remain reachable under their server workspace identity.

Both conversation components remain mounted so navigation preserves drafts and ongoing work. Managed deep links and explicit ordinary links retain their existing URL contracts. Ordinary permissions, filesystem, Git, trust, deletion and runtime controls are never offered as actions on Managed rows. The shared visual navigation does not migrate conversations, combine storage or add cross-provider operations.

A selected session's workspace resolution distinguishes pending, confirmed bound and confirmed legacy-unbound states. History replay to a different session invalidates the previous workspace before New task is allowed; replay or completion of the same session preserves its confirmed binding.

Explicit navigation and asynchronous command completion have separate callbacks. Clicking Managed history opens that conversation; a Managed create or submit that finishes after the user selects an ordinary conversation only updates its recorded Managed selection. Workspace creation uses the explicit choice described in [Workspace execution choice](2026-10-21-unified-workspace-navigation.md). Completing an open shared creation dialog selects the created workspace; dismissed or background operations do not switch the visible provider.

Acceptance requires no execution tab, simultaneous navigation for both providers, correct workspace grouping including empty and paged workspaces, provider-scoped selection, task creation and drafts, refresh and deep-link restoration, shared search, and explicit Managed errors without ordinary fallback. Existing ordinary-only and Managed-only embeddings must remain usable.

## Affected components and boundaries

- CLI local launcher, Managed proxy middleware and daemon embedding dependencies.
- WebShell authenticated boot, provider injection, shared workspace navigation and creation/selection regression tests.
- Existing local-delivery design and user instructions in both languages.

No new hosting mode, public Java endpoint, cross-provider Session conversion,
remote-daemon Managed fanout or release publication is included. The ordinary
daemon can use the launch directory. Managed work uses an application-created
Workspace or a project explicitly imported through the existing local directory
import capability, enabled by the loopback signed launcher.

The existing full-shell Mobile access / Local Control affordance is not
integrated: its paired LAN listener cannot pass the primary-listener Managed
boot gate. This change qualifies only the loopback application; adapting or
suppressing that affordance is follow-up work. Ordinary daemon Local Control
semantics are unchanged.

## Validation and acceptance

Run the global CLI first to record the unsupported baseline, then validate the
local bundle with isolated runtime/data directories. Confirm one listener serves
real daemon capabilities, ordinary Workspace APIs and authenticated Managed boot;
the UI presents both providers in one workspace navigation without execution tabs. Exercise an ordinary
Session and a Managed Session with deterministic model fixtures, refresh and
restore both, verify streaming and the ordinary ACP WebSocket, and stop the
launcher. Check that startup refusal and owned-service failure clean up only
owned services and retain durable data.

Focused tests cover raw-byte Java signatures, route ownership and refusals,
public boot authentication, provider origin/token binding, stale Local navigation,
launcher cleanup and the embedded signal policy. Run root build, typecheck and
bundle, affected CLI/WebShell tests, formatting and lint. The Java authorization
change for signed local-directory import is covered by its
[separate design](2026-10-21-managed-local-directory-import.md); report any
unavailable runtime or browser checks.

Acceptance passed with the rebuilt CLI and matching existing Java runtime on
macOS arm64: both Session types completed two turns, retained separate drafts,
and restored after refresh; a stale Local deep link restored Managed history.
Authenticated HTTP, raw-byte signatures, SSE and ACP WebSocket checks passed.
Normal and immediate shutdown, occupied-port fallback, restart persistence,
owned-service failure and missing-runtime refusal passed, with owned test
services cleaned up. Root build, typecheck and bundle, 215 relevant unit tests,
focused lint, formatting and documentation references passed. Model responses
were deterministic fixtures. Linux lifecycle, real-provider inference and
reboot recovery were not qualified by this change.

The shared-navigation revision passed 431 focused frontend tests, including workspace/session pagination, explicit selection refusals, pending creation, edited-directory confirmation, hidden Local ownership and background command completion. Browser acceptance exercised same-named ordinary and Managed workspaces and histories, independent drafts, actual new tasks in both providers, empty-workspace drafts, shared search, refresh with stale Local routes and browser back/forward. API read-back confirmed the new Managed task's exact workspace and the ordinary task's original cwd. Model calls used the isolated deterministic fixture. The initial exact-text wait for a new prompt was corrected to the fixture's actual `Fixture reply:` protocol; it was not a product failure. A targeted background-completion test first reproduced a navigation regression and passed after separating explicit navigation from result recording.

## Open questions

None required for this scope. Publishing matching runtime archives and additional
platform lifecycle qualification remain separate from this local implementation.
