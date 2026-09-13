# Demand-driven Web Shell metadata

[English](web-shell-demand-driven-metadata.md) | [简体中文](web-shell-demand-driven-metadata.zh-CN.md)

## Problem and scope

Expanded sidebar workspace rows currently fetch overview facets on mount, window
focus, and every 30 seconds even though their counts are only visible in hover
details or the workspace menu. The chat also loads and polls Git status without
checking an embedded host's `composerToolbarActions` configuration. Its session
provider independently fetches the branch during initialization and session load.
Source-filtered session lists also issue a discovery request before every read.

This change gates those reads by their consumers. It does not change endpoints,
workspace ownership, session-list refresh timing, or the workspace management table. The Git dialogs remain available for the active workspace.

## Behavior

- Overview facets load when the details popover opens after the existing 300 ms
  hover or keyboard-focus delay, or when the workspace menu opens. Expanded and
  collapsed rows behave alike. Merely revealing header action buttons does not
  load metadata.
- Existing 30-second and focus refreshes run only while one of those consumers
  is open. Closing both stops refreshes. The last snapshot remains available;
  reopening refreshes it. No new cache lifetime or request scheduler is added.
- Trusted-workspace and real-path guards remain in place. Custom headers only
  request overview facets when their consuming header menu is open.
- Remove the sidebar header Git button. The hover popover's branch row shows a plain-text summary on the right (for example, “6 modified · 11 stashed”), using the existing translated Git status phrases. Its terminal action uses `square-terminal`. Branch checkout, Changes, and Commit for a non-active workspace now require selecting that workspace first; the hover summary is not an interactive Git picker. Git status loads only while these details or a Git-dependent workspace menu is open; closing them stops the 60-second and focus refreshes.
- Chat Git reads run only when the visible composer includes `gitBranch`, or the environment panel is visible and includes the environment card. A configured but closed panel does not trigger reads. Omitting `composerToolbarActions` preserves the default toolbar choices; an explicit array without `gitBranch` disables that consumer.
- `WebShellWithProviders` disables redundant provider Git prefetches and lets
  the UI own those reads. Attached sessions can display the fetched branch
  before their first branch event. SSE branch updates remain supported.
- Low-level `DaemonSessionProvider` keeps its default behavior. Hosts that own
  their providers can set `prefetchGitBranch={false}` when their UI owns Git
  loading. This applies to both deferred initialization and session loading.

## Session source capability preflight

Source-filtered session lists share the parent `DaemonClient` capability
preflight across legacy and qualified routes. A successful discovery response
seeds a private copy of its feature set for 60 seconds. Checks reuse the latest
in-flight discovery request, or read the unexpired snapshot. Expiry causes an
on-demand refresh; there is no background timer or cross-client cache.

Public `capabilities()` calls always fetch fresh data and invalidate the old
snapshot immediately. A generation counter prevents older responses from
replacing newer features. The restore budget follows the newest successful response, so a newer failed discovery does not discard an older successful budget. Checks
waiting on a superseded request follow the current state, including when the
obsolete request fails. Failed discovery is not cached. Disposal invalidates
pending cache updates; the transport continues enforcing its closed state.

Only `session_source_metadata` checks use the cache, including session creation
and restoration. Missing-capability errors and restoration fallback behavior
remain unchanged. Other capability checks remain fresh, particularly memory
scope checks that protect against older
daemons silently ignoring a scope on a write. No new public option is added.
The cached discovery payload does not replace fresh workspace metadata reads.

Four cold source-filtered list reads now need one discovery plus four list
requests, sequentially or concurrently. With a valid initialization snapshot,
all four need only the list requests. Regression checks cover both routes,
expiry, initialization reuse, explicit refresh, out-of-order success/failure,
retry, missing capabilities, copied features, client isolation, disposal, and
fresh scope-sensitive checks. Run the SDK client and session-client unit tests
plus Web Shell workspace-provider tests to verify the consumer boundary.

## Providers for Settings

The App's providers hook serves model management in Settings. Enable its
automatic reads and event reloads only while project features are available
and Settings is open. SessionProvider retains its providers read for chat model
initialization. This removes one hidden-Settings request from chat startup;
opening Settings later adds one request. The [maintainer's real-daemon
verification](https://github.com/QwenLM/qwen-code/pull/11644#issuecomment-5649574918)
measured three startup requests before this change and two afterward: the
SessionProvider deferred-connect batch still ran twice during boot. That
intra-provider duplicate remains outside this change, so #11604 remains open.
Starting directly in Settings can still require both consumers.

Each opening reads fresh data once. The providers hook tells the shared event
reload helper when automatic loading already covers activation or a changed
loader, so reopening does not also issue an event-triggered read. Hidden events
do not fetch; visible settings events and explicit deletion/auth refreshes keep
working. Manual `autoLoad: false` consumers retain explicit loading and catch-up
on reenable. Other event-helper callers keep their existing behavior. No shared
providers cache or TTL is introduced.

Regression tests cover the App's open/close gate, one read per opening,
simultaneous activation and settings changes, hidden events, visible data
updates, explicit refresh, and manual-mode compatibility.

## Chat catalog demand loading

Web Shell sets `prefetchSkills={false}` to opt out of sessionless Skill prefetch; the low-level session provider
keeps its default. Opening slash suggestions, the composer Skill submenu, or
Help requests the current workspace catalog. A custom `renderFooter` also counts as a consumer because its public `skills` field has no separate load callback. Skills management keeps its own
on-open reads. Reuse an attached session's supported commands where available;
ordinary input and starting another chat do not preload the workspace catalog.

Keep one cached load and one in-flight read for the current workspace and
catalog revision and draft/session load mode. Settings, extensions, and Skill events invalidate the cache;
closed consumers defer reads until next opening. A mutation refresh already in flight may complete its bookkeeping after the menu closes, provided its session owner remains current. Preserve the existing partial
Skill-mutation recovery for attached sessions. Workspace changes invalidate
pending results. Configuration and ready-runtime Skill reads remain distinct.

Show loading and failure states without hiding the Skill submenu. Local slash
commands remain usable immediately; an unmatched slash query stays open while
the catalog loads. MCP/extension reference categories retain their existing
on-demand reads and per-search request reuse; their menu-lifetime caches remain
separate from management-page reads and filesystem caches.

Acceptance: no Skill prefetch for idle/ordinary/new chat without a custom footer; exactly one load per
unchanged workspace revision across repeated slash/Skill submenu openings;
visible loading, retry after failure, workspace isolation, fresh Skill changes,
and unchanged MCP/extension category demand loading. No endpoint is added.

Equivalent capability responses preserve the loaded catalog even when their feature arrays have new identities. Changes to the actual Skills protocol capabilities still invalidate the load. Command-refresh failures appear as errors in empty suggestions, clear on retry, and belong only to the session that failed. Changing either prefetch option at runtime reconnects the session; hosts should normally select those options when mounting their provider.

Runtime preparation errors retain the configuration fallback but surface failure and permit retry on reopening. Legacy primary-workspace daemons advertising ACP preheat prepare their runtime on first demand and then reread Skills. Clearing a session retains known commands only within the same workspace; opting out of prefetch must not erase custom commands that Skill reads cannot restore. Slash status messages appear only for empty results. A skipped provider prefetch preserves unknown command state. When submitting attachments with an unresolved slash command, read the session command snapshot before deciding whether to discard them; known commands and ordinary messages need no extra read. If this read fails before prompt admission, show the error and restore the unsent text and attachments into an empty composer in the same session; preserve any new user input. Empty queries can trigger the first load, but unmatched menus close after a successful catalog load. Attached sessions with pending extension or Skill changes retain empty suggestions until their deferred refresh completes, including when a new command is pasted directly.

## Live setup reads

Live setup status loads when Settings opens. Installation and launch progress poll every second only while Settings remains open; failed or not-yet-loaded status and an enabled, installed host awaiting readiness also keep polling. Stable states refresh on focus or page visibility changes. Closing Settings stops automatic reads. `sidebar.showLive` continues to control the sidebar group only. The setup card remains discoverable even when Live is disabled, so it can enable the feature.

## Constraints and risks

A hover opening incurs network latency; retained snapshots reduce blank states
on subsequent openings. Requests already sent may finish after closing, but
stale results are discarded by the existing overview hook. Visible consumers
retain their existing polling cadence. Visible independent Git consumers still request Git even when the composer action is hidden. Disabling a provider prefetch must
not erase branch events received in the same workspace while session metadata loads. A workspace switch clears the old branch; superseded sidebar Git responses cannot replace newer snapshots. Source capability
checks may retain an old decision within the 60-second cache lifetime; an
explicit `capabilities()` call refreshes it immediately.

## Validation and acceptance

Use the existing React/Vitest harness to verify no overview request on mount,
focus, or timer ticks while closed; delayed hover/focus loading; collapsed-row
loading; menu loading; and refresh cancellation on close. Verify no chat Git
read with an explicit toolbar excluding `gitBranch` and no environment consumer,
including focus and timer ticks; toggling consumers starts and stops reads.
Verify provider prefetch opt-out for sessionless and attached states, default SDK
compatibility, branch-event preservation, and branch rendering before an event.
Run focused package tests, the repository build, and typecheck. Browser checks
and baseline evidence are recorded under `.qwen/e2e-tests/`.

The workspace-overview Playwright smoke test covers zero idle reads, hover-triggered loading and the 30-second cadence, and stopping both overview and Git reads after details or the workspace menu closes. Expanding a row alone does not reload facets.
