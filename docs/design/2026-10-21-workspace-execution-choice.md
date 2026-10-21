# Workspace execution choice

[English](2026-10-21-workspace-execution-choice.md) | [简体中文](2026-10-21-workspace-execution-choice.zh-CN.md)

Status: implemented and verified on native macOS arm64 with a deterministic model. Date: 2026-10-21.

## Problem and current state

The shared Projects navigation contains daemon and Managed workspaces without execution tabs. Workspace creation still has separate entry points, so users cannot explicitly choose the service that owns a new workspace. New task inherits the current conversation or draft, but its execution type is not visible.

## Proposed behavior

The common Add workspace entry offers an Execution mode field: Local (daemon) or Managed (Managed Agent). It defaults to the current conversation's service. The field remains available in the existing directory dialog and Managed workspace creation dialog, so the user can change the choice before submitting. Managed offers its existing create-storage and import-directory workflows. Local retains daemon location, directory, trust and persistence controls. Switching modes changes the creation form; it does not register a workspace until the user submits. Canceling preserves the previous conversation and execution target.

The existing backend catalogs persist ownership. A daemon workspace remains a daemon workspace; a Managed workspace retains its server workspace ID and provider identity. The same physical directory can be registered separately in both catalogs. Neither directory text nor the page URL reclassifies a workspace. Workspace rows and New task show Local or Managed, and the Managed composer also includes its type beside the selected workspace name. Creating a task from a workspace continues to use its owning service.

## Components and decisions

Reuse a small shared execution field inside AddWorkspaceDialog and WorkspaceBindingCreator. App coordinates mode changes and controls the workspace dialog through ManagedSessionsPage. The existing Managed creator also serves this dialog above a history conversation without replacing that conversation. It mounts only for a draft or an explicitly open history creation dialog, preserving the existing session-creation lifetime. This preserves its pending-command receipts, idempotency, validation and directory authorization rather than duplicating the creation implementation. Changing an unsubmitted form is allowed; pending or uncertain Managed operations lock their execution type until resolved or explicitly abandoned. A successful local registration activates the local target. Background Managed completion keeps its existing non-navigation callback.

WorkspaceSection accepts a display label for local rows when Managed is available. The sidebar derives the New task type from its existing active-provider flag. Existing ordinary-only and Managed-only embeddings keep their existing controls. No API, Java, storage schema, provider conversion or remote Managed routing changes are required.

## Validation and acceptance

Add focused tests for switching forms without mutation, preserving conversations on cancel, disabling switches during submission or pending Managed operations, provider-specific registration and inherited New task routing. Test the global CLI baseline, then build, typecheck and bundle the local CLI. Use isolated native services and disposable project directories to register the same directory through both services, verify distinct catalog identities and sessions, and read back registrations after restart. Root performs browser checks with screenshots and verifies the user preview after restarting only its owned launcher. No actual user directory is registered for testing.

## Scope and open questions

This change adds explicit choice at workspace creation and visible task routing. It does not migrate an existing workspace or session between services, merge their storage, or add a combined cross-provider composer picker. There are no unresolved decisions for this scope.

## Verified UI

The follow-up PR was verified against the latest local-launcher parent on native macOS with a fresh matching JAR. The same disposable directory was registered through both browser forms, both services performed a real file read, and each history's New task inherited its service and workspace. Canceling preserved the Local conversation; Managed rename survived refresh and its creation Skills control remained available. The browser reported no console errors. Build, typecheck, bundle, 548 CLI tests, 406 focused frontend tests and full Maven verification passed (5,148 Java tests, 18 skipped).

![Workspace execution choice](assets/managed-workspace-execution-choice.jpg)

![Shared workspace navigation](assets/managed-unified-workspaces.jpg)
