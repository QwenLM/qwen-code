# Web Shell host-injected unavailable models

[English](web-shell-unavailable-models.md) | [简体中文](web-shell-unavailable-models.zh-CN.md)

## Problem

Embedded hosts often have a product catalog of models the current account
cannot use (plan, permission, or missing authorization). Those models should
still appear in the composer model picker as disabled rows. Hover or focus
opens a hint that can be plain text or host-owned UI, including action
buttons such as “Authorize”. The host may be SolidJS, so the public slot
cannot require React elements.

This is a catalog presentation. It is not authorization.

## Current state

The composer list comes from daemon `connection.models`, filtered by
`isVisibleComposerModel`, and rendered as selectable `ToolbarPopover`
buttons. Native `title` is only the overflow name. The built-in Tooltip
cannot hold buttons. Interactive hover already exists in
`ContextUsagePopover`. Framework-neutral custom UI already exists as
`mountFootnotePreview(container, info)` returning `{ update, dispose }`.

## Goals

- Hosts inject extra models that the daemon list does not offer.
- Those rows render disabled in the composer picker, including the
  reasoning submenu’s copy of the same list.
- Hover and keyboard focus open a hint. The hint may be a string or a
  host-mounted DOM tree with buttons.
- Solid and vanilla DOM hosts mount into an `HTMLElement`. They do not
  construct React elements.
- Available daemon models stay selectable. A colliding injected id is
  skipped.

## Scope

In scope: composer pickers on the main chat, split panes, and side tasks;
public types and README; English and Chinese design docs.

Out of scope: daemon and SDK routes; `/model`; `ModelDialog`; StatusBar;
Settings model management; footer `availableModels`; disabling models the
daemon already returned.

## Public API

Plain data plus one stable mount function:

```ts
export interface WebShellUnavailableModel {
  id: string;
  label?: string;
  tooltip?: string;
}

export interface WebShellUnavailableModelTooltipInfo {
  readonly model: WebShellUnavailableModel;
}

export interface WebShellUnavailableModelTooltipHandle {
  update(info: WebShellUnavailableModelTooltipInfo): void;
  dispose(): void;
}

export type WebShellUnavailableModelTooltipMount = (
  container: HTMLElement,
  info: WebShellUnavailableModelTooltipInfo,
) => WebShellUnavailableModelTooltipHandle | null | undefined;
```

`WebShellProps` (and therefore `WebShellWithProviders`) accepts
`unavailableModels` and `mountUnavailableModelTooltip`. The payload contains
no React, Solid, or AST objects.

Priority: a successful mount uses host content; omit, decline
(`null`/`undefined`), or a synchronous throw falls back to `model.tooltip`;
neither shows a hint, but the row stays disabled.

## Merge and selection

`appendUnavailableComposerModels` keeps available models first and appends
injected rows. It skips empty ids, ids already in the available list,
`HIDDEN_COMPOSER_MODEL_IDS`, and duplicate injected ids (first wins).
`isStandaloneModelPickerUnavailable` still inspects only the daemon catalog.

Clicking a disabled row does not call `onSelectModel`. Buttons inside the
hint are the host’s responsibility.

## Hint surface

Reuse a hover-intent Popover, not Tooltip or a new HoverCard. Open after
about 300ms, close after a short leave delay, stay open when the pointer
enters the content, and open on keyboard focus. The hint is a fixed-width
card: Web Shell renders the model name as the title and the string tooltip
as the description. Disabled rows keep a hover/focus highlight. Web Shell
owns placement, open/close, the portal, and the scroll bounds. The host
only fills the area under the title.

The hint is marked so the parent picker ignores outside pointer events and
does not close when the user clicks “Authorize”. Clicks inside the hint do
not select the model.

Mount lifecycle matches the footnote slot: keep the function referentially
stable; one successful mount has one dispose, including under React
StrictMode; hovering another disabled row updates the same view when the
mount function is unchanged; close, unmount, or replacing the mount
function disposes. A Solid host retains its reactive owner and tears down
`render` in `dispose`.

## Validation

Unit tests cover merge rules, disabled rendering, no selection on the row,
search, string fallback, mount/update/dispose, decline fallback, and a
button in the hint that neither selects the model nor closes the parent
picker. Composer, split, and side-task forwarding are covered at the
prop-thread sites. Browser evidence uses the existing ChatEditor DOM tests
and the settings harness picker.

![Disabled catalog models after available ones](assets/web-shell-unavailable-models-picker.png)

![Host string tooltip on a disabled model](assets/web-shell-unavailable-models-tooltip.png)

![Host-mounted authorize action in the hint](assets/web-shell-unavailable-models-authorize.png)

## Acceptance

- An omitted or empty list leaves the picker unchanged.
- Injected models appear after available ones and cannot be selected.
- A host string tooltip appears on hover and focus.
- A host mount can render a button; clicking it does not switch models or
  dismiss the picker.
- Solid or DOM hosts do not need a React element factory.
- Daemon-available models remain selectable even when the same id is also
  injected.
