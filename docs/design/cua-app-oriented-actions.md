# App-oriented Computer Use

[English](cua-app-oriented-actions.md) | [简体中文](cua-app-oriented-actions.zh-CN.md)

## Problem and evidence

The Computer Use facade requires the model to track process IDs, window IDs,
opaque element tokens and input delivery modes. Its AX text repeats tokens,
frames and default attributes. These costs persist even inside Node REPL.

This change is based on PR #11683 at
`9ad582281de6d79350b255a63b7f7757e14ec11e`. The independent references are the
user-provided Qoder Computer Use Dev.app (9999.0.0; runtime SHA-256
`777e909734044f0b3de199e37ff4a680bbfb5800026553b1d4da8f9480a3da44`) and
ChatGPT.app 26.901.51231, build 8109 (`@oai/cua` 0.2.4 / `@oai/sky` 0.6.26).
The package manifest and extracted symbols are retained as local audit evidence;
the reference binaries and extracted implementation are not included in this PR.

Readable Codex JavaScript binds an application string to short action methods;
its native service supplies the AX text. Qoder's supplied binary contains app
resolution, per-app snapshot ownership, synthetic focus handling and AX tree
transformation implementations. The previous benchmark traces independently
confirm app-string targeting, compact numeric element IDs and runtime-owned
window changes. Symbols alone do not establish every native routing or pruning
condition. No proprietary implementation is copied.

## Native alignment status after the deeper audit

The native audit on 2026-09-12 pins SkyComputerUseService 26.831.1000926,
SHA-256 `25e9141499b94c396f39afbdb7b19ed8f49e45dc8c61be61028ceab8f3807ce6`.
The disassembly, metadata, call-site evidence and owned-document probes are
retained locally. The PR's E2E report records the verification outcomes and limits.

Confirmed principles are canonical installation identity, per-app serialization,
focused/main/last AX window selection, separate open-menu context, structural
projection before revision rendering, and native semantic or synthesized input
without a general foreground retry. Qwen implements these principles using its
existing driver. This is not a reproduction of every private Codex transform or
its three-field synthetic focus controller. Application-specific calendar and
attributed-text transforms remain unverified and are not inferred from names.

## Implementation after native reverse engineering

The native app list reports canonical paths from the actual running app's
bundle URL and deduplicates installations by path. The facade keeps the
resolved path as both cache identity and refresh selector. A discovered
installed app may be opened by getState through the existing background
launcher; actions must not restart a terminated app.

An optional app-context flag on typed window-list and observation inputs
connects app handles to native AX selection and compact capture. Native window
selection reads focused/main/last AX window and attached sheets, verifying
the actual window owner before returning it. The facade consumes that decision
instead of computing a z-index policy. Exact-window consumers retain their
existing behavior. App context uses the existing element cache, mutation
coordinator and revision store; fresh native reads handle focus/menu changes
and process replacement.

App observations collect a structural tree before projection. The projection
preserves actionable identities and descriptive state, removes empty redundant
containers, merges safe text-only structure, and includes only immediate
menu-bar entries for normal window observations. An observed open menu becomes
the menu root and retains descendants, including disabled descriptions.
Pruning must not depend on enabled state alone. Compact rendering and its
revision lineage are separated from legacy full-tree output. Unknown
application-specific Codex transforms are not guessed from their names.

App keyboard actions use native background focus preparation and PID delivery. The facade
no longer chooses a mode from cached capability/role heuristics or retries
after a refusal. Native code chooses semantic versus synthesized input using
current target facts. Missing proof or unconfirmed effects return an error or
unverifiable receipt without replay. Explicitly foreground exact-window
consumers keep that option. Native fixes cover unadvertised text-control
presses and unverified text writes/confirmation, avoiding known no-op and
duplicate-input paths.

Validation is in `.qwen/e2e-tests/cua-native-alignment.md`: path collisions and
termination, AX focus selection with reversed stacking order, menu/dialog
context and stale IDs, full/diff/no-change, precise Unicode/punctuation input,
and foreground ownership sampling during background actions. The final model
run uses MRKey GPT-6 with its actual request configuration recorded. No new
process, transport or permission owner is introduced.

## Runtime and ownership

The existing topology remains Node REPL → standalone CU facade → typed native
SDK → existing platform driver. There is no additional process, executable,
network service, package installation or permission owner. Existing trusted
session ownership, target checks and cleanup remain authoritative.

The model obtains an app handle using a discovered name, application identifier
or launch path. That handle owns the current window, observation and short-ID
mapping. The public workflow no longer accepts process/window/token or input
mode choices. The existing exact-window API remains available to programmatic
SDK consumers; the canonical model Skill moves to the app API.

## Behavior and scope

The app workflow is implemented for macOS. Existing exact-window APIs retain
their platform contracts. App identity is the canonical installation path when
available. Names and identifiers must resolve uniquely; the handle never falls
through to another installation when its original path disappears. getApp only
binds identity. getState can launch a discovered stopped app through the typed
launch_app method and then refresh its process identity. Actions never launch an
app. Process, window-owner, window-ID and connection changes invalidate old IDs.

AX capture preserves structural nodes and meaningful disabled/focused/selected
state. Projection removes undescriptive layout containers, redundant text below
a labelled ancestor and plain text sibling duplication without discarding any
addressable node. Text merging preserves web-content boundaries and auxiliary
semantics. The native app-tree-v1 lineage renders short IDs without opaque tokens,
per-node frames or default attributes. Full/diff/no-change selection still uses
native identity and replay validation. Legacy full-tree-v1 cursors are separate.

App clicks and keyboard input use the native background path. A supported semantic action is
selected before dispatch; writable text focus or an exact pointer target handles
controls without Press. An error after dispatch never triggers another actuator.
AX text writes with unknown or unchanged readback stop without a Unicode resend.
Only a proven complete insertion confirms text; substring matches and length-only
partial suffix retries are removed. Unicode CGEvent delivery is retained.

Before background PID keys, native code checks the exact window, sends an AppKit
synthetic activation notification (type 13, subtype 1), waits for it to be consumed,
and checks the target again. Already-frontmost targets skip the notification.
The notification does not call real app activation or a global HID queue. This
implements the confirmed activation-before-input principle without introducing
Codex's private event-tap belief cache; that state machine is not claimed identical.

App drags carry the internal app-context flag. Before dispatch the native driver
chooses its supported foreground HID route, raises only the exact AX window, and
checks that the system hit-test at the drag start belongs to that window before
posting mouse input. A frontmost process alone does not establish window ordering.
The guard restores the previous app afterward. It does not first send a background drag. This is a
Qwen platform limitation and is not claimed to reproduce Codex's drag delivery.

For multiple windows in one process, background keyboard delivery requires fresh
AXFocusedWindow plus an AXFocused first responder whose ancestry matches the
selected window. The check runs again after focus preparation, immediately before
PID events. Semantic menu actions can use a separate proof to the app's fresh
AXMenuBar while confirming the target as its focused window; that proof cannot
authorize pointer or keyboard delivery. Stale/foreign window, visibility and
unproven-element checks remain in force.

## Affected components and validation

Changes cover the facade, typed contract and generated bindings, macOS app/window
resolution, native AX capture/projection/revision rendering and input paths,
canonical Skill, package contents and 0.20.6 release metadata. Runtime topology,
authorization ownership and exact-window platform support remain unchanged.

Run SDK tests/types, targeted native and core Skill tests, build/typecheck/bundle,
package verification and `.qwen/e2e-tests/cua-native-alignment.md`. GUI checks use
owned fixtures with independent AX/file verification. The final smoke uses
MRKey GPT-6; record actual request parameters and all inference usage. Character
counts and a smoke do not establish aggregate 20-task benchmark savings.
