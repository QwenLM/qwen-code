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

Remove the legacy 18-action touch grid and simulated Tab/Esc keys while keeping
a permanent single-row 6-key editing bar above the textarea: up (`↑`), down
(`↓`), right / accept follow-up (`→`), insert slash (`/`), hide keyboard, and
expand editor. Keep add, model, approval, dictation, and send controls in the
bottom toolbar. Hide the width toggle on touch; retain the context-usage
control when enabled by the host.

Adapt workspace and Git context placement to the composer container's inline
width so the editing row never wraps onto two lines:

- **Wide (`≥ 560px`, iPad landscape/wide split, phone landscape):** workspace
  selection and full Git controls sit inline on the leading side of the single
  editing row with ellipsis truncation alongside the 6 editing keys.
- **Medium (`420px–559px`, iPad narrow split, foldables):** workspace selection
  stays inline with truncation while the Git control collapses to its compact
  icon form alongside the 6 editing keys on the same single row.
- **Narrow (`< 420px`, phone portrait, iPad Slide Over):** the editing row is
  dedicated solely to the 6 editing keys (`↑ ↓ → /` leading, hide keyboard and
  expand trailing). When `contextChipPlacement` is not `header` (such as a
  new-session composer), workspace and Git move to a single-row non-wrapping
  strip below the composer while the textarea is blurred (staying open while a
  branch picker is active) and hide automatically while focused; when
  `contextChipPlacement` is `header`, workspace is not duplicated below the
  composer. At or below 320px (`≤ 320px`), the below-composer strip collapses labels while
  preserving icon and conflict badge indicators.

Retain the inline context row's measured height allowance in the composer's
height cap on wide/medium touch layouts. Context and editing controls must not
overlap. Preserve host-provided toolbar slots.

Keep 44px touch targets for bottom-toolbar and workspace/Git controls. Editing
keys use a 36px visual height plus a 4px transparent band above and below.
Their minimum visual widths are 34px, or 26px at the tiny-container tier; this
explicit narrow-width allowance is not a blanket promise of 44×44px keys.
Adjacent hit areas must not overlap. The bottom-right button group may wrap
inside the available width to keep stop and send reachable at the required
touch size. Center toolbar icons in their targets and remove extra gaps within
the mobile toolbar groups, including the context-usage button. Allow model and
mode labels to shrink with ellipsis so long model names do not prematurely wrap
the bottom toolbar. Keep Plan as an active-state chip. While a turn runs, stop remains available alongside send
when there is a draft; stopping never clears that draft. Voice capture retains
its existing reduced toolbar and hides the context and editing rows.

The editing row stays permanently single-row (`flex-wrap: nowrap`) across all
widths without page overflow or horizontally clipped editing keys. Hide
keyboard reserves its trailing slot so focus changes never shift the row, and
blurs without returning focus through the composer surface click handler.
Hosts without Add keep Shell and history-search entries in the bottom toolbar.
A modal expanded
editor edits the same controlled draft, preserves its selection when returning,
and does not submit when closed. Its Done and keyboard controls are touch
sized. Shell mode gets an explicit exit action. Session/workspace changes and
disabled state close expanded editing.

Up and down move the caret within the draft and right moves to the next
grapheme or accepts a completion when offered. They never step through prompt
history on touch: restoring entries into a plain textarea cannot rebuild the
rich inline tag chips, so history recall stays in the dedicated search panel.
Shell entry/exit and history search live in the Add drawer; hosts that omit
Add keep both entries in the bottom toolbar instead of squeezing extra
controls into the editing keys' line. The narrow editing row therefore holds
exactly the six editing controls even during Shell mode. Inline and
below-composer workspace and Git controls retain 44px targets.

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
button retains a reachable command picker on mobile outside Shell mode.
Hosts without Add retain Shell and history-search buttons in the bottom
toolbar; this fallback does not enable file ingestion or references.

The mobile context controls have a single mutually exclusive menu owner, while
the Git mode's unconfirmed branch draft is owned above the inline/below
placements. Crossing a container-width tier must retain the open menu and
unconfirmed input; closing and reopening still initializes from the current
intent. A header-owned workspace is excluded from both mobile context
placements. Host-provided Git controls with their own rendering may shrink with text
ellipsis in the medium tier rather than being clipped after intrinsic width. In the
narrow below-composer row, top padding absorbs the negative margin so each
44px control starts outside the composer surface; do not lift the row's opaque
background with z-index above the surface. The text-only Git tooltip does not
receive pointer events, so its arrow cannot retarget a touch compatibility
mouseup and suppress the component's click. The no-Add Shell/history fallback
buttons must not forward activation to the draft while history search is open.

The history search must have a visible close action and remain touch usable.
It opens upward from the composer, so its height is also capped by the room
between the composer and the top of the visible chat area. When even its
minimum height does not fit, it overlaps the top of the composer instead of
going under the header, so its search field and close action stay on screen
with a soft keyboard open. The same positioning applies to desktop history
search: when a short window leaves insufficient room above the composer,
the panel overlaps its top so the search field stays visible. Desktop editing
and keyboard shortcuts retain their existing behavior.
The bound is the top of the lowest ancestor that
clips overflow. A host whose own header overlays the shell without clipping
it must declare `--web-shell-popover-safe-top`; that variable is also how a
host opts out of the default clearance, and a declared `0px` is honoured
rather than swallowed.
File selection must stay in a user gesture, and deferred insertions must run
after the drawer releases focus. Expanded editing must preserve attachment
and reference state in the shared composer, including IME input. Image/file
paste uses the existing ingestion lane; long-text paste uses the active
editor's selection when deciding whether to fold it into an attachment.
All imperative text insertion and focus target the expanded textarea while it
is mounted. The dialog retains the input placeholder and mobile text settings,
shows the shared attachment/image count, and returns focus without stealing it
from a newly opened approval dialog. Closing idle Live voice returns to Add.

The command page uses shared completion labels, sections, priority, hints and
subcommand results (up to 50 matches), normalizes a leading slash and surrounding
whitespace, and retains description search as a fallback. Search stays visible
while scrolling. Commands and skills are unavailable in Shell mode. Skills only
announce an empty catalog after loading has completed.

## Validation and acceptance

Use the global qwen CLI for a baseline attempt and the repository browser
harness for deterministic UI coverage. Verify local bundled UI when available.
Record any runtime limitations separately from mocked browser results.

- At phone widths, the old 18-action grid and Tab/Esc keys are absent; the
  editing row contains only the 6 editing keys (`↑`, `↓`, `→`, `/`, hide
  keyboard, expand editor). Workspace/Git move below the composer while
  blurred at narrow container widths (`< 420px`) and remain inline at medium
  container widths (`420px–559px`, compact Git) or wide container widths
  (`≥ 560px`, full Git). These thresholds are measured against the composer
  container, not the viewport; an open sidebar can keep an iPad in the narrow
  tier. Existing sessions whose header already owns the workspace do not
  duplicate it below the composer. Toolbar actions remain reachable without
  horizontal overflow; desktop toolbar behavior remains unchanged.
- Desktop Ctrl+R keeps the search field visible and focused in a short window
  (1280x300), overlapping the composer when necessary. Escape preserves the
  draft and returns focus to the editor. With enough room, the panel remains
  above the composer.
- With a soft keyboard open at a Pixel 7 keyboard height (about 412x450),
  attachments stay reachable as the narrow below-composer strip unmounts on
  focus; medium/wide inline context also receives its measured height back
  inside the cap. The history search field and close action remain reachable
  below the header. Below roughly 430px of viewport height the composer is
  already at its cap, so the attachments strip shrinks toward a sliver.
- Stop works with a pending draft and keeps the draft; send still queues it.
- Hide keyboard blurs the editor; expand/edit/Done preserves text, selection,
  attachments, and references. Switching sessions cannot leak expanded drafts.
- Drawer pages support tap/back/close; native photos/camera/files choose the
  correct destination; cancel leaves text intact. Provider errors and disabled
  actions remain honest, and Plan toggles exactly once.
- Commands and skills preserve existing drafts and tags; history can be opened,
  selected, or dismissed. Live voice remains accessible.
- History search restores a selected input and the draft focus without
  submitting. The composer container boundaries resolve narrow at 419px,
  medium at 420px and 559px, and wide at 560px. At 1024px, 480px, 390px,
  345px, 320px, 310px, and 240px viewport widths, all 6 keys remain on one
  row inside the editing container, respect their width floors, and produce
  no horizontal page overflow. Coordinate hit tests must resolve the actual
  key 3.5px above and below its 36px visual box, confirming that the 44px
  vertical touch band is effective rather than merely declared.
- At narrow widths, verify the full 44px context buttons lie outside the
  composer surface and actual `top + 2px` taps open their menus. Cross width
  tiers with a live menu and unconfirmed Git text, checking state retention.
  In the medium tier, verify a host-provided long-branch control keeps its
  chevron inside and clickable. Wide long-workspace fixtures must supply real
  labels and demonstrate actual text overflow, not a generic fallback label.
- Run focused unit/browser tests, build, typecheck, bundle, and two clean
  self-audit passes plus independent review.

## Open questions

None for implementation. Real-device iOS/Android keyboard and camera behavior
must be distinguished from browser emulation in the verification report.
