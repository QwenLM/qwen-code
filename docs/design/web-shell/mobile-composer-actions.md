# Mobile composer actions

[English](mobile-composer-actions.md) | [简体中文](mobile-composer-actions.zh-CN.md)

## Problem and scope

The touch composer exposes a grid of up to 18 actions and six keyboard keys.
Several actions duplicate navigation and settings; Tab does nothing on the
textarea backend. The stop button disappears when a running session has a
draft. Small controls and horizontal add-menu submenus make phone use harder.

This change is confined to Web Shell UI. Desktop editing, daemon routes,
permissions, attachment limits, and host toolbar opt-ins retain their existing
contracts. Mobile means the existing touch textarea backend, including its URL
override; narrow desktop windows keep desktop editing.

## Design

### Toolbar and editing

Remove the legacy touch action grid and simulated keyboard keys. Keep add,
model, approval, dictation, and send controls. Hide the width toggle and the
duplicate context control on touch. Put workspace selection and Git controls
in a separate context row so starting a task in a particular workspace or
branch remains possible. Preserve host-provided toolbar slots.

Use 44px touch targets and wrap controls on very narrow viewports rather than
clip them. Keep Plan as an active-state chip. While a turn runs, stop remains
available alongside send when there is a draft; stopping never clears that
draft. Voice capture retains its existing reduced toolbar.

Add a small editing row with expand and, while the textarea is focused, hide
keyboard. Hide keyboard blurs without returning focus through the composer
surface click handler. A modal expanded editor edits the same controlled draft,
preserves its selection when returning, and does not submit when closed. Its
Done and keyboard controls are touch sized. Shell mode gets an explicit exit
action. Session/workspace changes and disabled state close expanded editing.

### Touch add menu

Keep the existing desktop dropdown. On touch, use the shared portal-aware
bottom Drawer with one visible page at a time, a Back button, and a Close
button. Reuse provider searches, availability checks, attachment destinations,
skill prefix insertion, and session/workspace invalidation.

Offer photos, camera, message files, and upload to workspace as explicit
actions. Photos use an image-only file picker; camera requests rear capture.
Native file-picker cancellation preserves the draft. Browser/device support
determines how the native picker presents capture.

File references, extensions, MCP server references, and skills have dedicated
pages with scrolling. Reference search remains workspace-wide. Plan stays a
checked row. Add input history and a searchable command page: choosing a
command prefixes its invocation to the existing draft for review, and never
automatically runs it. This keeps Shell, Goal, and infrequent session commands
available without independent shortcuts or draft replacement. A labelled Live
voice entry moves into the drawer, with an active-call indicator retained in
the toolbar.

## Implementation and constraints

Changes affect ChatEditor, AddMenu, their CSS and tests, Git popover sizing,
the shared paste handler, LiveVoiceButton, and English/Chinese strings.
Reuse the existing Dialog and Drawer primitives and
Web Shell portal root. No new dependency or public customization API is needed.
The add control remains host opt-in. A host that explicitly enables a command
button retains a reachable command picker on mobile.

The history search must have a visible close action and remain touch usable.
File selection must stay in a user gesture, and deferred insertions must run
after the drawer releases focus. Expanded editing must preserve attachment
and reference state in the shared composer, including IME input. Image/file
paste uses the existing ingestion lane; long-text paste uses the active
editor's selection when deciding whether to fold it into an attachment.

## Validation and acceptance

Use the global qwen CLI for a baseline attempt and the repository browser
harness for deterministic UI coverage. Verify local bundled UI when available.
Record any runtime limitations separately from mocked browser results.

- At phone widths, the old action grid and keyboard keys are absent; toolbar
  actions are reachable with no horizontal overflow. Desktop behavior remains.
- Stop works with a pending draft and keeps the draft; send still queues it.
- Hide keyboard blurs the editor; expand/edit/Done preserves text, selection,
  attachments, and references. Switching sessions cannot leak expanded drafts.
- Drawer pages support tap/back/close; native photos/camera/files choose the
  correct destination; cancel leaves text intact. Provider errors and disabled
  actions remain honest, and Plan toggles exactly once.
- Commands and skills preserve existing drafts and tags; history can be opened,
  selected, or dismissed. Live voice remains accessible.
- Run focused unit/browser tests, build, typecheck, bundle, and two clean
  self-audit passes plus independent review.

## Open questions

None for implementation. Real-device iOS/Android keyboard and camera behavior
must be distinguished from browser emulation in the verification report.
