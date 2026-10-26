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
- Keep secondary controls accessible without placing them in the resting row.
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
actions are available. Simple mode supplies the add entry point without requiring
the host to add `'addMenu'` to its toolbar list. Existing placeholder overrides
continue to apply.

## Composer layout and interactions

Reuse the existing `ChatEditor` and `useComposerCore` instances. Simple mode does
not introduce another editor backend or submission path.

At rest, a subtle rounded border encloses a low-height row. The add button sits
on the left, the flexible editor occupies the middle, and primary actions sit on
the right. The editor must have enough inline space reserved for the buttons so
text never renders beneath them. Long text grows to a bounded multiline editor;
attachments can add space above the input without being clipped by the capsule.

On touch devices configured with `'simple'`, a `Settings2Icon` button directly
switches the same composer to advanced mode, using the existing full mobile
presentation inline. Advanced mode provides a `PanelBottomCloseIcon` button to
return to the simple row. Both buttons occupy the same toolbar position to the
left of voice/send. Their labels are “Switch to advanced mode” and “Switch to
simple mode.” Neither action opens a menu or fullscreen editor dialog, and no
action changes the iOS native editing menu. Keep the text, attachments, and
editor DOM node through both transitions. The `advancedMode` flag is local
presentation state, without persisting a setting or changing `composerVariant`.
Default-mode and desktop composers do not gain this toggle.

When there is content to submit, the send control is available. When empty, reuse
the existing voice entry if its capability and configuration permit it. This
empty-voice/content-send rule also applies in advanced mode for a composer
configured with `'simple'`. If voice is unavailable, an empty idle input retains
the disabled send control instead of rendering a placeholder microphone.
Preserve existing preparing, disabled, running, queued-input, and stop semantics.
Existing live voice surfaces remain reachable through the add menu as appropriate.

The existing CodeMirror and touch textarea paths retain their keyboard behavior,
Chinese IME composition handling, and multiline editing. Do not remount the
editor merely to change the visible action. Buttons retain accessible names and
keyboard focus behavior, and touch targets remain usable on narrow screens.

## Secondary controls and add menu

Reuse `AddMenu` and add an internal toolbar-content slot for the simple
presentation. Move the existing applicable workspace, approval-mode, model,
context, and host toolbar controls into this secondary surface instead of
reimplementing their state or handlers. Preserve configured action availability
and capability checks; moving a control must not enable an excluded action.

The desktop add menu remains a `DropdownMenu`; touch devices retain the existing
`Drawer` presentation. Keep the current attachment, upload, reference, skill, and
Plan entries. Expanded controls and nested popovers use Web Shell's existing
portal-root integration. Host toolbar renderers remain accessible in the
secondary surface rather than widening the simple input row.

## Constraints and risks

- Keep default-mode markup and styling behavior unchanged where practical; scope
  new CSS to the simple variant.
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
   overflow, overlapping buttons, or clipped previews.
5. Text input, Chinese IME composition, multiline editing, sending, and attachments
   work through the existing editor and submission paths.
6. Preparing, disabled, running, queued-input, and stop behavior remain correct.
   The empty-voice/content-send rule applies in both simple and advanced layouts;
   unavailable voice leaves a disabled send control for empty idle input rather
   than a nonfunctional microphone.
7. The add menu and its controls support touch and keyboard interaction, including
   nested popovers, focus restoration, accessible labels, and light/dark themes.
8. Tests exercise the public configuration flow, variant-specific rendering,
   submission and menu behavior. Browser verification covers narrow mobile and
   desktop layouts. Run the repository's required build and typecheck checks.
9. A touch-device composer configured with `'simple'` can switch directly to the
   existing full mobile input through `Settings2Icon` and return through
   `PanelBottomCloseIcon`, preserving text, attachments, and the editor DOM node.
   Both buttons sit to the left of voice/send. Neither action opens a menu or
   fullscreen dialog or changes the iOS native editing menu; the default and
   desktop presentations have no additional toggle.

These are verification requirements, not claims that validation has already
passed. Record actual results in the E2E report and change summary.

## Open questions

None for this implementation. Any future persisted preference or broader page
redesign requires a separate proposal.
