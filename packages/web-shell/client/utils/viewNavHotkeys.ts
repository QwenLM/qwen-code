// The remaining view navigation hotkeys for the Web Shell, paired with the
// Session Overview / Split View chords in App's `onViewShortcut` listener
// (#13175). These chords navigate the rendered surface (approval cards,
// Session Overview, the Pinned section, split panes, composer controls),
// so this module touches only the DOM; App applies the covering-surface
// guards (modals, the fullscreen artifact panel, the web terminal,
// editable targets) before delegating here.
//
// A chord consumes the event (preventDefault + stopPropagation) only when
// it acted, or when it deliberately swallows the key (for example Cmd+4
// with three Overview rows); otherwise the key is left to the browser,
// mirroring the existing Overview/Split chords.

import { parseSessionId } from './sessionPath';

/** 1–9 for the main number row (`Digit1`–`Digit9`), 0 otherwise. Numpad
 *  codes are deliberately out of scope. */
export function modifierDigit(e: KeyboardEvent): number {
  return e.code.startsWith('Digit') ? Number(e.code.charAt(5)) : 0;
}

/** Option+Shift+1–9 (the macOS checkbox chord) — without Cmd/Ctrl. */
export function isOverviewCheckboxChord(e: KeyboardEvent): boolean {
  return (
    e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && modifierDigit(e) > 0
  );
}

function consume(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Laid out (non-zero width) and not hidden by `visibility`. Width alone is
 * not enough: the compact shell keeps its closed sidebar drawer laid out
 * under `visibility: hidden` (App.module.css, so the fade-out can finish),
 * and the computed value is inherited, so descendants of the closed drawer
 * report it too.
 */
function isVisible(el: Element | null | undefined): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.offsetWidth <= 0) return false;
  const visibility = getComputedStyle(el).visibility;
  return visibility !== 'hidden' && visibility !== 'collapse';
}

function isDisabled(el: HTMLElement): boolean {
  return (
    (el instanceof HTMLButtonElement && el.disabled) ||
    el.hasAttribute('data-disabled')
  );
}

function isEligible(el: HTMLButtonElement): boolean {
  return isVisible(el) && !isDisabled(el);
}

/**
 * The Session Overview's session rows. DataTable renders its empty state
 * (`data-slot="data-table-empty"`, no click handler) as a row of the same
 * tbody whenever no row matches, so it is not a row target.
 */
function overviewRows(viewport: Element): HTMLElement[] {
  return Array.from(viewport.querySelectorAll<HTMLElement>('tbody tr')).filter(
    (row) => row.getAttribute('data-slot') !== 'data-table-empty',
  );
}

function focusPaneComposer(pane: HTMLElement): void {
  pane.focus({ preventScroll: true });
  const content = pane.querySelector<HTMLElement>(
    '[data-web-shell-composer-editor] .cm-content',
  );
  if (content) {
    content.focus({ preventScroll: true });
    return;
  }
  pane
    .querySelector<HTMLElement>('[data-web-shell-composer-editor]')
    ?.focus({ preventScroll: true });
}

/**
 * Picks the approval panel to act on, in decreasing priority: the one
 * containing the focused element, then the one in the same split pane as
 * the focus (a composer focus sits outside every card of its pane),
 * otherwise the first visible panel.
 */
function pickVisiblePanel(panels: NodeListOf<Element>): Element | null {
  const visible = Array.from(panels).filter(isVisible);
  const active = document.activeElement;
  const contained = visible.find((panel) => panel.contains(active));
  if (contained) return contained;
  const pane =
    active instanceof Element ? active.closest('[data-pane-session-id]') : null;
  if (pane) {
    const inPane = visible.find((panel) => pane.contains(panel));
    if (inPane) return inPane;
  }
  return visible[0] ?? null;
}

/**
 * The Pinned section's header button: the visible button carrying
 * `data-web-shell-pinned-header`. WebShellSidebar renders exactly one,
 * and the mark — not the rendered label — identifies it, so the lookup
 * survives any active locale (`ru` is user-selectable and currently
 * reads the English label through the i18n fallback).
 */
function findPinnedHeader(): HTMLButtonElement | null {
  const headers = document.querySelectorAll<HTMLElement>(
    'button[data-web-shell-pinned-header]',
  );
  for (const header of Array.from(headers)) {
    if (!isVisible(header)) continue;
    return header as HTMLButtonElement;
  }
  return null;
}

/**
 * Marks the option a hotkey focus lands on, for the focus ring. WKWebView
 * does not match :focus-visible on programmatic focus during keydown, so
 * ToolApproval.module.css also matches the mark; the mark is removed when
 * the option loses focus, so the ring follows the focus like
 * :focus-visible does.
 */
function markHotkeyFocused(option: HTMLElement): void {
  document
    .querySelectorAll('[data-web-shell-hotkey-focused]')
    .forEach((el) => el.removeAttribute('data-web-shell-hotkey-focused'));
  option.setAttribute('data-web-shell-hotkey-focused', '');
  option.addEventListener(
    'blur',
    () => option.removeAttribute('data-web-shell-hotkey-focused'),
    { once: true },
  );
}

/**
 * Option+Shift+1–9 (macOS) — toggles the Nth Session Overview row's
 * checkbox. A no-op without consumption when the table is hidden or the
 * row does not exist; when the row is found the event is consumed even if
 * that row has no checkbox. Covering modals are App's guard
 * (shellHotkeyTargetsClear), which matches the modal primitives rather
 * than role="dialog": non-modal popovers (session details) carry that
 * role too and must not disable the chord.
 */
export function pressOverviewRowCheckbox(e: KeyboardEvent): boolean {
  const n = modifierDigit(e);
  const viewport = document.querySelector(
    '[data-web-shell-session-table-viewport]',
  );
  if (!isVisible(viewport)) return false;
  const row = overviewRows(viewport)[n - 1];
  if (!row) return false;
  consume(e);
  row
    .querySelector<HTMLElement>('[role="checkbox"], input[type="checkbox"]')
    ?.click();
  return true;
}

/** The surface a Cmd/Ctrl+digit press acts on, with its targets. */
type DigitStage =
  | { kind: 'approval'; options: HTMLElement[] }
  | { kind: 'overview'; rows: HTMLElement[] }
  // rows: null while the section is collapsed (the press expands it).
  | { kind: 'pinned'; header: HTMLButtonElement; rows: HTMLElement[] | null }
  | { kind: 'panes'; panes: HTMLElement[] };

/**
 * Resolves the digit chord's priority chain once, for both consumers:
 * pressNavigationDigit acts on the result and showNavDigitPreview numbers
 * it, so the preview cannot drift from what the next press does (Shift
 * included).
 */
function resolveDigitStage(shift: boolean): DigitStage | null {
  // 1. Approval card (without Shift).
  if (!shift) {
    const panel = pickVisiblePanel(
      document.querySelectorAll('[data-web-shell-permission-panel]'),
    );
    if (panel) {
      const group = panel.querySelector('[role="radiogroup"]');
      // Direct button children — the `:scope > button` equivalent without
      // a scoped selector (jsdom's scoped-selector matching is unreliable).
      const options = group
        ? Array.from(group.children).filter(
            (child): child is HTMLElement => child instanceof HTMLButtonElement,
          )
        : [];
      return { kind: 'approval', options };
    }
  }

  // 2. Session Overview.
  const viewport = document.querySelector(
    '[data-web-shell-session-table-viewport]',
  );
  if (isVisible(viewport)) {
    return { kind: 'overview', rows: overviewRows(viewport) };
  }

  // 3. Pinned section (without Shift).
  if (!shift) {
    const header = findPinnedHeader();
    if (header) {
      if (header.getAttribute('aria-expanded') === 'false') {
        return { kind: 'pinned', header, rows: null };
      }
      const list = header.parentElement?.nextElementSibling;
      const rows = isVisible(list)
        ? Array.from(list.querySelectorAll<HTMLElement>('div[role="button"]'))
        : [];
      return { kind: 'pinned', header, rows };
    }
  }

  // 4. Split panes. SplitView keeps the panes hidden by a maximized
  // sibling mounted (their sessions keep streaming), so only the visible
  // ones are numbered.
  const panes = Array.from(
    document.querySelectorAll<HTMLElement>('[data-pane-session-id]'),
  ).filter(isVisible);
  return panes.length > 1 ? { kind: 'panes', panes } : null;
}

/**
 * Cmd/Ctrl+1–9 (with Shift when the Overview is visible or in split
 * view) — navigates by priority:
 *
 * 1. Approval card (without Shift): focuses the Nth option. The card
 *    wins and always consumes, even when it has fewer than N options
 *    (the extra digit is swallowed), no option group at all, or the Nth
 *    option is disabled (a Goal card while it submits).
 * 2. Session Overview: clicks the Nth row while the table is visible
 *    (the key is consumed even with fewer than N rows).
 * 3. Pinned section (without Shift): the first press expands a
 *    collapsed section; the Nth pinned row is clicked. When the section
 *    is present but nothing matches, the key stays unconsumed and the
 *    panes are not touched.
 * 4. Split panes: focuses the Nth visible pane and its composer (the key
 *    is consumed even with fewer than N panes).
 *
 * Returns whether the event was consumed.
 */
export function pressNavigationDigit(e: KeyboardEvent): boolean {
  const n = modifierDigit(e);
  const stage = resolveDigitStage(e.shiftKey);
  if (!stage) return false;
  switch (stage.kind) {
    case 'approval': {
      // Focus, not click. A disabled option cannot take focus, so it is
      // neither marked nor focused; the card still claims the key.
      consume(e);
      const option = stage.options[n - 1];
      if (option && !isDisabled(option)) {
        markHotkeyFocused(option);
        option.focus();
      }
      return true;
    }
    case 'overview':
      consume(e);
      stage.rows[n - 1]?.click();
      return true;
    case 'pinned': {
      if (stage.rows === null) {
        stage.header.click();
        consume(e);
        return true;
      }
      const row = stage.rows[n - 1];
      // The section is present but nothing matches: leave the key
      // unconsumed and do not touch the panes.
      if (!row) return false;
      row.click();
      consume(e);
      return true;
    }
    case 'panes': {
      consume(e);
      const pane = stage.panes[n - 1];
      if (pane) focusPaneComposer(pane);
      return true;
    }
  }
}

const NAV_PREVIEW_STYLE_ID = 'webShellNavPreviewStyle';
const NAV_PREVIEW_ATTR = 'data-web-shell-nav-preview';
const NAV_PREVIEW_ANCHOR_ATTR = 'data-web-shell-nav-preview-anchor';

function ensureNavPreviewStyle(): void {
  if (document.getElementById(NAV_PREVIEW_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = NAV_PREVIEW_STYLE_ID;
  style.textContent = `
[${NAV_PREVIEW_ANCHOR_ATTR}] { position: relative; }
[${NAV_PREVIEW_ATTR}]::after {
  content: attr(${NAV_PREVIEW_ATTR});
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--agent-blue-500, #3b82f6);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  pointer-events: none;
  z-index: 1;
}`;
  document.head.appendChild(style);
}

/**
 * The elements a Cmd/Ctrl+1..9 press would act on, by position — read off
 * the same resolver as pressNavigationDigit, so the claim semantics match:
 * the approval card wins even with no options, the Overview table even
 * with no rows, the Pinned section even when collapsed (the first press
 * would expand it, not navigate, so it numbers nothing). A `null` keeps a
 * position that the press would not act on (a disabled approval option)
 * unnumbered without renumbering the ones after it.
 */
function navPreviewTargets(shift: boolean): Array<HTMLElement | null> {
  const stage = resolveDigitStage(shift);
  if (!stage) return [];
  switch (stage.kind) {
    case 'approval':
      return stage.options.map((option) =>
        isDisabled(option) ? null : option,
      );
    case 'overview':
      // Badge the row's last cell (it has the free right edge); fall back
      // to the row itself for cells without a trailing td.
      return stage.rows.map(
        (row) => row.querySelector<HTMLElement>('td:last-child') ?? row,
      );
    case 'pinned':
      return stage.rows ?? [];
    case 'panes':
      return stage.panes;
  }
}

/**
 * Numbers 1..9 over the next digit-navigation targets — the macOS-menu
 * canon for "what this modifier does next". App calls it on each Cmd/Ctrl
 * keydown and again when Shift joins or leaves the held modifier (`shift`
 * selects the Shift chain, which skips the approval and Pinned stages),
 * so the badges name what the next press does. The badge is a CSS ::after
 * driven by a data attribute, not an extra DOM node: React re-renders of
 * the rows cannot drop or duplicate it mid-hold. At most nine targets are
 * numbered, in DOM order; the numbers are positions, matching the chord.
 */
export function showNavDigitPreview(opts: { shift?: boolean } = {}): void {
  ensureNavPreviewStyle();
  hideNavDigitPreview();
  navPreviewTargets(opts.shift ?? false)
    .slice(0, 9)
    .forEach((el, i) => {
      if (!el) return;
      // The ::after needs a positioned containing block. An already
      // positioned target keeps its own position — the Overview's actions
      // cell is `sticky` (right-pinned while the table scrolls sideways),
      // and forcing `relative` there would unpin it — so only a static
      // target is anchored.
      const position = getComputedStyle(el).position;
      if (position === '' || position === 'static') {
        el.setAttribute(NAV_PREVIEW_ANCHOR_ATTR, '');
      }
      el.setAttribute(NAV_PREVIEW_ATTR, String(i + 1));
    });
}

/** Removes any number-preview badges. */
export function hideNavDigitPreview(): void {
  document
    .querySelectorAll(`[${NAV_PREVIEW_ATTR}], [${NAV_PREVIEW_ANCHOR_ATTR}]`)
    .forEach((el) => {
      el.removeAttribute(NAV_PREVIEW_ATTR);
      el.removeAttribute(NAV_PREVIEW_ANCHOR_ATTR);
    });
}

/**
 * Cmd/Ctrl+Shift+F — maximizes/restores the focused split pane by
 * pressing its header button. A no-op without consumption when no pane
 * contains the focused element, the pane is hidden, or it has no
 * maximize button.
 */
export function pressPaneMaximizeToggle(e: KeyboardEvent): boolean {
  const active = document.activeElement;
  const pane =
    active instanceof Element ? active.closest('[data-pane-session-id]') : null;
  if (!isVisible(pane)) return false;
  const button = pane.querySelector<HTMLElement>(
    '[data-web-shell-pane-maximize-button]',
  );
  if (!button) return false;
  consume(e);
  button.click();
  return true;
}

/**
 * Cmd/Ctrl+Shift+\ — "Open in Split" for the selected Session Overview
 * rows. While the Overview table is visible the key is consumed: the
 * footer's "Open in Split" button (SessionOverviewPanel marks it with
 * data-web-shell-session-split-button and renders it only while a
 * selection is active) is clicked; with no rows selected there is no
 * button and the key is swallowed.
 */
export function pressSelectedRowsSplit(e: KeyboardEvent): boolean {
  const viewport = document.querySelector(
    '[data-web-shell-session-table-viewport]',
  );
  if (!isVisible(viewport)) return false;
  consume(e);
  document
    .querySelector<HTMLElement>('[data-web-shell-session-split-button]')
    ?.click();
  return true;
}

/**
 * Cmd/Ctrl+T (without Shift) — the two-stage "new task" chord: on a
 * session screen it presses the "New task" button, on the new-task
 * screen it opens the workspace picker. When the session screen offers
 * no eligible button the key stays unconsumed and the picker stage is
 * not attempted. The session screen is recognised with the base-path
 * aware parser (the URL is `${basePath}/session/<id>`), not a prefix
 * match on the raw pathname.
 */
export function pressNewTask(e: KeyboardEvent): boolean {
  if (parseSessionId(window.location.pathname) !== undefined) {
    const buttons = document.querySelectorAll(
      'button[data-web-shell-new-task-button]',
    );
    for (const button of Array.from(buttons) as HTMLButtonElement[]) {
      if (!isEligible(button)) continue;
      consume(e);
      button.click();
      return true;
    }
    return false;
  }
  const triggers = document.querySelectorAll(
    'button[data-web-shell-workspace-select-trigger]',
  );
  for (const trigger of Array.from(triggers) as HTMLButtonElement[]) {
    if (!isEligible(trigger)) continue;
    consume(e);
    openRadixTrigger(trigger);
    return true;
  }
  return false;
}

/**
 * Opens a Radix DropdownMenu trigger programmatically. A bare `.click()`
 * does not open the menu — Radix keys off pointer events — but a primary
 * `pointerdown` does, so a full synthetic mouse sequence is dispatched.
 * Radix's trigger toggles on that pointerdown, so an already open menu
 * (the trigger's own `aria-expanded` / `data-state`) is left open rather
 * than closed.
 */
export function openRadixTrigger(el: HTMLElement): void {
  if (
    el.getAttribute('aria-expanded') === 'true' ||
    el.getAttribute('data-state') === 'open'
  ) {
    return;
  }
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  );
  el.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      detail: 1,
    }),
  );
  el.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  );
  el.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
    }),
  );
  el.click();
}
