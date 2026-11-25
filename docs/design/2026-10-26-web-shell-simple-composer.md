# Configurable Simple Composer for Web Shell

[English](2026-10-26-web-shell-simple-composer.md) | [简体中文](2026-10-26-web-shell-simple-composer.zh-CN.md)

Status: Implementation design

Date: 2026-10-26

Issue: [#15647](https://github.com/QwenLM/qwen-code/issues/15647)

## Problem and current behavior

Web Shell's composer places an editor above a toolbar with session controls.
Hosts can select toolbar actions and customize placeholders, but cannot select
the slim, single-row input shown in the issue's mobile reference. Narrow embedded
panels and lightweight chat experiences need a smaller input at rest.

The main chat renders `ChatEditor` directly. Split-view and side-task chats render
it through `ChatPane`. All three already share Web Shell's customization context.
Desktop editing uses CodeMirror; touch devices use the existing textarea backend.
The composer already owns attachment ingestion, submission, cancellation, voice
capability checks, and the add menu.

## Goals and scope

- Offer an optional simple composer through both public component entry points.
- Keep the existing composer as the default.
- Show a pill-shaped row containing an add button, the editor, and the primary
  voice, send, or stop action.
- Keep the simple add menu focused on attachments and references; retain the
  existing secondary controls in advanced mode.
- Preserve text editing, attachments, input methods, and session behavior.
- Apply the same presentation to main chat, split panes, and side-task chats.

The reference applies only to the message input. The page header, character
image, and bottom navigation are outside this change. This change adds no daemon
configuration, persisted setting, settings-page control, or new voice capability.

## Public API and configuration flow

Add the following optional prop to `WebShellProps`:

```ts
composerVariant?: 'default' | 'simple';
```

`WebShellWithProvidersProps` inherits this prop. Omission and `'default'` retain
the current presentation. Hosts opt in directly:

```tsx
<WebShellWithProviders composerVariant="simple" />
```

Carry the value in the existing `WebShellCustomization` context. Both main chat
and pane composers read the same value from that context, avoiding separate
configuration paths through split-view and artifact-panel components. This prop
controls presentation; it does not change daemon capabilities or permissions.

Existing toolbar-action configuration continues to determine which optional
actions are available in the default and advanced presentations. Simple mode
supplies its limited add menu without requiring the host to add `'addMenu'` to
its toolbar list. Switching to advanced mode restores the original configured
toolbar, without force-enabling additional actions. Existing placeholder
overrides continue to apply.

## Composer layout and interactions

Reuse the existing `ChatEditor` and `useComposerCore` instances. Simple mode does
not introduce another editor backend or submission path.

At rest, a subtle rounded border encloses a low-height row. The add button sits
on the left, the flexible editor occupies the middle, and primary actions sit on
the right. The editor must have enough inline space reserved for the buttons so
text never renders beneath them. Long text grows to a bounded multiline editor;
attachments can add space above the input without being clipped by the capsule.
The simple row's add and microphone icons share the same larger visual size;
the add icon uses a neutral gray. Advanced mode keeps their original sizes and
colors.

Keep attachments in the existing flex stack and constrain the simple input row
separately. In short viewports, the editor scrolls within the remaining height
while the add and primary action stay inside the capsule. The row wrapper uses
`display: contents` in default and advanced mode to preserve their layout.

On touch devices configured with `'simple'`, a `Settings2Icon` button directly
switches the same composer to advanced mode, using the existing full mobile
presentation inline. In the simple row, the settings button sits to the left of
voice/send. Advanced mode adds only a `PanelBottomCloseIcon` return button before
the existing voice controls, keeping the microphone immediately next to send:
return → microphone → send. Its existing layout, controls, action behavior,
and icon sizing remain unchanged. Their labels are “Switch to advanced mode”
and “Switch to simple mode.” Neither action opens a menu or fullscreen editor
dialog, and no action changes the iOS native editing menu. Keep the text,
attachments, and editor DOM node through both transitions. Returning to simple
mode exits Shell mode, so the retained draft uses normal chat submission without
requiring the hidden Shell controls. The `advancedMode`
flag is local presentation state, without persisting a setting or changing
`composerVariant`. Default-mode and desktop composers do not gain this toggle.

In the simple row, the send control is available when there is content to submit.
When empty, reuse the existing voice entry if its capability and configuration
permit it. If voice is unsupported or unavailable, show the send control, disabled
while the idle input is empty, without rendering a microphone fallback.
This mutual exclusion and the simple mode's larger microphone apply only while
the simple layout is shown.
Advanced mode restores the original voice and send visibility, sizing, and
behavior, including their coexistence where the original composer provides it.
Preserve existing preparing, disabled, running, queued-input, and stop semantics.
While preparing a session or images, hide the idle microphone and keep the
disabled loading action; an ongoing recording or transcription remains visible.

During recording or transcription in simple mode, the existing voice control
occupies the whole capsule row. Temporarily hide the editor, add button, mode
toggle, and submit controls without unmounting the editor. Let the recording
control fit its waveform, elapsed time, and stop action without the idle
microphone's fixed 44px width. Restore the normal simple row when voice activity
finishes. Insert the final transcript only after the editor is visible again,
so focus and textarea auto-grow run against a visible element. CSS applies the
height cap even when the textarea sizing fallback is used. Advanced and default
recording/transcription presentations remain unchanged.

The existing CodeMirror and touch textarea paths retain their keyboard behavior,
Chinese IME composition handling, and multiline editing. Do not remount the
editor merely to change the visible action. Buttons retain accessible names and
keyboard focus behavior, and touch targets remain usable on narrow screens.

## Secondary controls and add menu

Reuse `AddMenu` with a simple presentation limited to these eight action kinds:

1. Photos.
2. Camera.
3. Add a file attachment.
4. Upload to the workspace.
5. Reference a file.
6. Extensions.
7. MCP.
8. Skills.

Respect the existing platform and capability checks for each entry. When no
simple action is available, show the existing localized empty-state explanation.
Do not place
commands, history, shell mode, Plan, live voice, or secondary toolbar controls in
the simple add menu. No internal toolbar-content slot is needed. Workspace,
approval-mode, model, context, and host toolbar controls remain part of the
original advanced presentation.

The desktop add menu remains a `DropdownMenu`; touch devices retain the existing
`Drawer` presentation. Default and advanced menus retain their original entries
and configuration behavior. Expanded controls and nested popovers continue to use
Web Shell's existing portal-root integration.

## Constraints and risks

- Keep default-mode layout and styling behavior unchanged. Advanced mode adds
  only the return button before the existing voice controls; simple layout,
  recording, and icon overrides must not affect its existing controls.
- Preserve public `data-web-shell-*` hooks, theme variables, and portal scoping.
- Keep action state owned by the existing composer and its session-scoped
  handlers; a menu must not switch a different session or workspace.
- Nested controls in a menu can close their parent or lose focus unexpectedly.
  Verify selection, popover opening, dismissal, and focus restoration on both
  desktop and touch surfaces.
- Long input, attachments, and voice activity can change required height. Verify
  those states rather than relying only on an empty-input screenshot.

## Validation and acceptance criteria

1. Both `WebShell` and `WebShellWithProviders` accept `composerVariant="simple"`;
   omitted configuration and `'default'` preserve the existing composer.
2. Main chat, split panes, and side-task chats select the same configured variant.
3. Empty simple input is a slim capsule with an add button, editor, and available
   primary action. Secondary controls do not occupy the resting input row.
4. Long text and attachments expand within the available space without horizontal
   overflow, overlapping buttons, or clipped previews. Short viewports with many
   tags keep both action buttons inside the capsule and the last draft line
   reachable by scrolling.
5. Text input, Chinese IME composition, multiline editing, sending, and attachments
   work through the existing editor and submission paths.
6. Preparing, disabled, running, queued-input, and stop behavior remain correct.
   Empty-voice/content-send mutual exclusion applies only to the simple layout;
   unsupported or unavailable voice leaves a disabled send control in the empty
   idle input, without a microphone fallback. Advanced mode preserves the
   original voice and send behavior and sizing.
7. The add menu and its controls support touch and keyboard interaction, including
   nested popovers, focus restoration, accessible labels, and light/dark themes.
8. Tests exercise the public configuration flow, variant-specific rendering,
   submission and menu behavior. Browser verification covers narrow mobile and
   desktop layouts. Run the repository's required build and typecheck checks.
9. A touch-device composer configured with `'simple'` can switch directly to the
   existing full mobile input through `Settings2Icon` and return through
   `PanelBottomCloseIcon`, preserving text, attachments, and the editor DOM node.
   The settings button sits left of voice/send in simple mode; the return button
   precedes the voice controls in advanced mode, leaving microphone next to send.
   All other advanced controls
   remain unchanged. Neither action opens a menu or fullscreen dialog or changes
   the iOS native editing menu; the default and desktop presentations have no
   additional toggle.
10. The simple add menu contains only the eight defined action kinds, subject to
    platform and capability checks. Commands, history, shell mode, Plan, live
    voice, and secondary toolbar controls remain outside this menu; default and
    advanced presentations retain their original configured behavior.
11. During simple recording/transcription, the voice control spans the capsule
    row without clipping the waveform, timer, or recording stop action. The
    editor remains mounted while the editor, add, mode, and submit controls are
    hidden; finishing voice activity restores them. The transcript receives
    editor focus and grows correctly with native and fallback textarea sizing.
    Advanced/default recording and transcription remain unchanged.

These are verification requirements, not claims that validation has already
passed. Record actual results in the E2E report and change summary.

## Open questions

None for this implementation. Any future persisted preference or broader page
redesign requires a separate proposal.
