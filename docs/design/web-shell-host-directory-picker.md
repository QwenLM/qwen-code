# Web Shell host directory picker

[English](web-shell-host-directory-picker.md) | [简体中文](web-shell-host-directory-picker.zh-CN.md)

Status: implementation proposal for [#15186](https://github.com/QwenLM/qwen-code/issues/15186). The API shape and precedence below are choices for this implementation, pending maintainer review; the issue discussion has not approved a final public contract.

## Problem and current behavior

An embedding application may already provide a directory browser for its headless daemon. Web Shell's internal Add Workspace dialog accepts a picker, but its public components cannot supply one. The current wiring uses the daemon's native picker only for the connected target, when `native_directory_picker` is advertised and the origin condition is satisfied. Hiding that picker on a headless host is intentional.

The [standalone app already browses remote directories](remote-web-shell-daemon.md). That browser is separate from reusing an embedding application's own UI. A host can instead select a directory externally and use public workspace actions, but must then coordinate registration, capability refresh, and selection itself.

## Public API and precedence

Add an optional top-level `onPickWorkspaceDirectory` prop to `WebShellProps`, also accepted by `WebShellWithProviders`. Its publicly exported type is `WebShellWorkspaceDirectoryPicker`, with signature `(opts?: { signal?: AbortSignal }) => Promise<string | undefined>`. The options object follows existing cancellation conventions. The host returns an existing absolute directory path on the currently connected daemon's filesystem, or `undefined` when the user cancels. Browser-local directory handles do not satisfy this contract.

Use the existing Browse button. When a host callback is configured, it takes precedence over the native picker. Returning `undefined`, cancelling, or throwing does not fall back to the native picker. Without a callback, preserve the existing native capability, target, and origin checks and manual path entry. No additional precedence setting or second picker button is introduced.

The host callback is available only for the selected target that matches the connected daemon, and only while `workspace.status === 'connected'`. While that status is unmet, Browse is absent and a configured host callback does not fall back to the native picker. The callback does not require `native_directory_picker` or a same-origin page, so authenticated cross-origin embeddings can use it. Selecting another computer in the standalone Folder source control must not invoke the connected daemon's host callback. The host owns its directory browser and must bind it to the same daemon it supplies to Web Shell.

The selected path only fills the existing dialog. The user still presses Add to register it. Existing registration validation, persistence capability checks, refresh, selection, error handling, and workspace trust semantics remain authoritative. Selecting a path neither registers a workspace nor grants trust. While a selection is pending, Add is disabled and the submit handler rejects submission, so an earlier path cannot be registered while the picker is still choosing its replacement.

The Git URL source uses the same picker for its parent-directory Browse action. The host still returns an existing directory; the dialog combines that parent with the repository name derived from the URL to fill the clone target. Choosing a directory does not start cloning or registration. The existing Git clone flow requires a separate submission and keeps its target validation and trust semantics.

## Invocation lifecycle

Each selection receives its own `AbortController` and is bound to the selected target and connection identity at invocation. The daemon client instance identifies its base URL, credentials, and transport; the dialog also tracks the selected location and connection status. Close, unmount, a target or connection change, switching between host and native picker modes or between local-folder and Git URL sources, or a replacement selection invalidates the old invocation and aborts its signal. Switching modes cancels the old invocation even when a picker remains available. The host should use the signal to close its picker UI and cancel associated requests. Local-folder and Git-parent selection share this lifecycle, busy state, and focus handoff.

The dialog also checks invocation identity before applying a result or error and before clearing busy state. A host that ignores abort cannot let a late resolve or reject overwrite a newer selection, change the current path, show a stale error, or clear another invocation's busy state. User cancellation through `undefined` or an `AbortError` leaves the dialog usable; other failures use its existing picker-error presentation.

Recreating an inline callback during an ordinary render does not represent a new daemon connection and does not cancel an in-flight selection. A subsequent selection uses the latest callback. Target and connection changes are tracked independently from callback identity.

A host may render its picker outside the Web Shell portal. The modal Add Workspace dialog otherwise blocks pointer and focus access to that UI. Only while a host picker is pending, Add Workspace temporarily becomes nonmodal; it restores modal behavior after completion or cancellation. The host owns its picker's accessibility, focus management, and stacking order. `DialogShell` retains a default of `modal: true`, and the native picker path retains its modal behavior. This is an internal handoff, not a new public dialog configuration.

Changing Radix's modal mode still remounts the dialog content; DOM identity is not preserved. Browser observation confirms that these remounts replay the entrance animation; suppressing that animation during handoff is deferred. `DialogShell` saves and restores its body's scroll offsets through the body ref. While the host is pending, focus stays with any host UI that has already claimed it. Otherwise, a shadow-root-aware `isFocusUnclaimed` check allows focus to park on the Add panel. On completion or cancellation, focus returns to the newly mounted Browse button, or the panel if that button is unavailable, using `preventScroll`. While choosing, the panel exposes `aria-busy` and Browse displays “Choosing directory…”.

While either picker is pending, directory navigation is locked and the suggestion combobox is collapsed. In directory-browsing mode, an inert placeholder preserves the hidden list's height so the body does not shrink and clamp its scroll offset. The picker snapshots the list's own scroll position and restores it only if the same suggestion results return; a newly selected directory starts its list at the top.

If another `DialogShell` opens concurrently, restoring the lower dialog's modal mode can still leave Radix layer ordering and `aria-hidden` ordering incorrect; this case remains unresolved. Horizontal layout shifts with classic scrollbars have not been validated.

Escape retains the existing Add Workspace close behavior: `DialogShell` handles it during document capture, before an external host picker's ordinary bubbling handler, closing Add and aborting the picker. An explicit Cancel action in the host picker can instead return `undefined` and leave Add open. Independent Escape ownership that cancels only the host picker remains a decision for review and is not included in this change.

The same stale-result guard protects the native path, but this proposal does not widen the daemon action, SDK, or backend cancellation contract. Client-side invalidation does not guarantee that a server-side native OS dialog closes. Native request timeouts and server-side behavior remain unchanged.

## Implementation scope

- `packages/web-shell/client/App.tsx`: public prop, host-first wiring, and target/connection identity supplied to the dialog.
- `packages/web-shell/client/components/dialogs/AddWorkspaceDialog.tsx`: options-based internal callback, cancellation, invocation ownership, guarded submission, busy presentation, and temporary host-UI handoff.
- `packages/web-shell/client/components/dialogs/DialogShell.tsx`: internal modal option defaulting to `true`, body scroll restoration, and focus handoff across modal changes.
- `packages/web-shell/client/customization.tsx` and `index.tsx`: define and publicly export `WebShellWorkspaceDirectoryPicker`; both public components retain their existing forwarding path.
- Public-entry and dialog tests, `packages/web-shell/README.md`, and this bilingual design.

No dialog replacement API, directory-creation API, new backend filesystem endpoint, broader workspace policy, Managed Agent picker change, or exposure of standalone browser mode is included. Git clone execution remains in the existing clone flow.

## Validation and acceptance

Add behavioral tests before implementation and confirm they fail against the baseline. Through the public component entry and real dialog interactions, verify host selection on headless and cross-origin connections, host-over-native precedence, no fallback on cancellation/errors or loss of connected status, path population without registration, and the normal Add flow. For Git URL, verify that selecting an existing parent fills the derived clone target without starting a clone or registration. Retain coverage of native capability/origin checks and registration, persistence, and trust semantics.

Exercise user cancellation, real failure, repeated selection, close, unmount, target and connection changes, ordinary callback rerenders, and late resolve/reject from a host that ignores abort. Assert visible path/error/busy state and registration side effects, not just prop forwarding or callback counts. Confirm that pending selection prevents both button and form submission and that switching host/native modes invalidates old results.

In a real browser, operate a host picker rendered outside the Web Shell portal and verify keyboard and pointer access, focus returning to Browse after selection and cancellation, and restored modal behavior. Also cover a pending host without browser UI, visible busy state, and preservation of a scrolled dialog body. Only the host-owned UI interaction case is tagged `@smoke`; the remaining browser cases are not added to that selection. Run affected tests, build, type checking, lint, preflight, and applicable browser interaction checks; record actual outcomes and environment limitations separately from this acceptance plan.

## Decisions for review

The top-level prop, options-object signature, and host-first single-button behavior keep this change narrow and easy to adjust. Maintainers may still revise their naming, placement, and precedence during review. Full cancellation of native picker requests and processes would require separate end-to-end analysis; adding a signal parameter alone does not establish that guarantee.
