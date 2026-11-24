# Unified workspace navigation

[English](2026-10-21-unified-workspace-navigation.md) | [简体中文](2026-10-21-unified-workspace-navigation.zh-CN.md)

Status: implemented. Date: 2026-10-21.

## Problem and scope

The full Web Shell already accepts a Managed provider alongside its daemon connection. Its Local/Managed tabs hide the other service's workspaces, and the task workspace menu cannot select targets from both catalogs. Users need one Projects list, workspace-owned new tasks, and an explicit service choice when adding a workspace.

This change is independently based on main and changes only the Web Shell. Hosts continue supplying the existing `managedAgentProvider`; the existing Java Vite demonstration remains available with `?managedProvider=java&managedWorkspace=1`. CLI launchers, runtime installation/download, proxy authentication, Java services, API contracts and storage schemas are outside this change. No dependency on #14928 is required.

## Shared navigation and identity

Remove the execution tabs and render Managed workspace groups inside the existing Projects list alongside daemon workspaces. Empty workspaces remain selectable. Display Local or Managed directly beside each workspace name and use the same compose icon for each workspace's New task action. The top New task action displays and inherits the selected conversation or draft's service.

The Managed page retains one session catalog and projects its navigation through the sidebar slot. The sidebar shares its search query with that catalog. Workspace discovery and both catalog paginations retain their existing provider APIs and explicit load-more controls. Sessions whose workspace is outside the current discovery page remain reachable under their server workspace identity.

Managed identities retain the provider storage key and server workspace/session IDs. Daemon identities retain their original host, cwd, trust and runtime selection. Matching names, directories or IDs never merge the catalogs. Ordinary filesystem, Git, trust, deletion and runtime actions stay attached to their daemon owners. An inactive daemon conversation loses its selection highlight while its existing actions still refer to that conversation.

## New tasks and workspace selection

Creating a task from a workspace uses that workspace's existing provider. The draft workspace menu lists available targets from both catalogs and labels their service. Selecting a target opens a draft without creating a workspace or session. Each service retains its unsent draft. Managed targets are revalidated before creation; unavailable or unresolved explicit targets cannot fall back to another Managed workspace or the daemon primary.

Workspace resolution distinguishes pending, confirmed bound and confirmed legacy-unbound sessions. Replaying a different history entry clears the previous workspace while the target resolves; replay or completion of the same session retains its confirmed binding. New task waits for this resolution when necessary.

Both conversation components remain mounted to preserve drafts and ongoing work. Explicit history selection changes the visible conversation. A background Managed create/submit completion records its result without leaving the selected Local conversation. Existing URL restoration contracts remain in use; this change introduces no new boot marker or launcher-specific provider injection.

## Workspace creation

The existing Add workspace entry offers Local (daemon) or Managed (Managed Agent), defaulting to the current conversation's service. Changing the service switches forms without registration. Local retains its existing location, directory, trust and persistence controls. Managed reuses its existing empty creation, authorized-directory selection and capability-gated local import flows. The server continues deciding which capabilities and paths are authorized.

Reuse the existing Managed creator and its pending-command receipts, idempotency, edited-directory confirmation and recovery. Pending or uncertain Managed commands lock the execution choice until resolved or explicitly abandoned. Canceling preserves the selected conversation. Successful creation from an open dialog selects the resulting workspace; a dismissed or background operation cannot steal navigation.

## Compatibility and boundaries

Ordinary-only hosts retain their existing controls, with no execution labels or Managed catalog. Managed-only embeddings retain their existing session creation and history behavior. No workspace/session is migrated or converted, and the services keep separate storage and authorization. Existing daemon SSH locations follow the daemon flow; this change adds no Managed SSH registration or cross-host Managed routing.

## Validation and acceptance

1. Configure the existing provider in a full Web Shell. Confirm both catalogs appear without execution tabs, including empty and paged workspaces, and that service labels sit beside names.
2. Select workspaces in both directions from New task, including primary and secondary daemon targets. Confirm original identity, independent drafts, and no workspace/session creation before submission.
3. Create one disposable workspace through each form. Switching or canceling must not register a workspace or change the conversation; a successful open dialog must select the created workspace.
4. Exercise search, history, refresh, legacy-unbound sessions and delayed background completion. Explicit targets must retain ownership and fail without fallback. Pending receipts must survive retries and prevent service switching while uncertain.
5. Verify daemon-only and Managed-only hosts, including actions on an inactive daemon session. Run root build/typecheck/bundle, affected Web Shell tests, focused formatting/lint and browser checks using isolated data. Report simulated-backend checks separately from real-service acceptance.

## UI evidence

The current main-based browser captures use the existing Vite Java provider, an isolated real daemon and a Managed API fixture. They verify frontend selection and creation behavior, not Java execution or runtime delivery. The before capture is the existing pre-unification fixture screenshot from #15040.

![Before: execution tabs](assets/unified-workspace-navigation-before.png)

![After: both catalogs in the task menu](assets/unified-workspace-navigation-picker.jpg)

![Explicit workspace execution choice](assets/unified-workspace-navigation-execution.jpg)

![Shared navigation at a narrow viewport](assets/unified-workspace-navigation-after.jpg)

## Open questions

None required for this UI scope. Single-command local service startup and runtime distribution remain separate work in #14928 and its service-integration follow-up.
