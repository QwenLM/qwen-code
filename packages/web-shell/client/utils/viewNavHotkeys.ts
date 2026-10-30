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

function isVisible(el: Element | null | undefined): el is HTMLElement {
  return Boolean(el && el instanceof HTMLElement && el.offsetWidth > 0);
}

function isEligible(el: HTMLButtonElement): boolean {
  return (
    el.offsetWidth > 0 && !el.disabled && !el.hasAttribute('data-disabled')
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
 * Picks the approval panel to act on: the one containing the focused
 * element when there is one, otherwise the first visible panel.
 */
function pickVisiblePanel(panels: NodeListOf<Element>): Element | null {
  let fallback: Element | null = null;
  for (const panel of Array.from(panels)) {
    if (!isVisible(panel)) continue;
    if (panel.contains(document.activeElement)) return panel;
    fallback ??= panel;
  }
  return fallback;
}

/**
 * The Pinned section's header button: the first `aria-expanded` button
 * whose label (its first child span) reads "Pinned" or "置顶" and which
 * is visible. The Web Shell ships only English and Simplified Chinese, so
 * matching the exact label covers every locale.
 */
function findPinnedHeader(): HTMLButtonElement | null {
  const headers = document.querySelectorAll('button[aria-expanded]');
  for (const header of Array.from(headers)) {
    const label = header.firstElementChild;
    const text = label instanceof HTMLSpanElement ? label.textContent : null;
    if (text !== 'Pinned' && text !== '置顶') continue;
    if (!isVisible(header)) continue;
    return header as HTMLButtonElement;
  }
  return null;
}

/**
 * Option+Shift+1–9 (macOS) — toggles the Nth Session Overview row's
 * checkbox. A no-op without consumption when a dialog is open, the table
 * is hidden, or the row does not exist; when the row is found the event
 * is consumed even if that row has no checkbox.
 */
export function pressOverviewRowCheckbox(e: KeyboardEvent): boolean {
  const n = modifierDigit(e);
  if (document.querySelector('[role="dialog"]')) return false;
  const viewport = document.querySelector(
    '[data-web-shell-session-table-viewport]',
  );
  if (!isVisible(viewport)) return false;
  const row = viewport.querySelectorAll<HTMLElement>('tbody tr')[n - 1];
  if (!row) return false;
  consume(e);
  row
    .querySelector<HTMLElement>('[role="checkbox"], input[type="checkbox"]')
    ?.click();
  return true;
}

/**
 * Cmd/Ctrl+1–9 (with Shift when the Overview is visible or in split
 * view) — navigates by priority:
 *
 * 1. Approval card (without Shift): focuses the Nth option. The card
 *    wins and always consumes, even when it has fewer than N options
 *    (the extra digit is swallowed) or no option group at all.
 * 2. Session Overview: clicks the Nth row while the table is visible
 *    (the key is consumed even with fewer than N rows).
 * 3. Pinned section (without Shift): the first press expands a
 *    collapsed section; the Nth pinned row is clicked. When the section
 *    is present but nothing matches, the key stays unconsumed and the
 *    panes are not touched.
 * 4. Split panes: focuses the Nth pane and its composer (the key is
 *    consumed even with fewer than N panes).
 *
 * Returns whether the event was consumed.
 */
export function pressNavigationDigit(e: KeyboardEvent): boolean {
  const n = modifierDigit(e);
  const shift = e.shiftKey;

  // 1. Approval card: focus, not click.
  if (!shift) {
    const panel = pickVisiblePanel(
      document.querySelectorAll('[data-web-shell-permission-panel]'),
    );
    if (panel) {
      consume(e);
      const group = panel.querySelector('[role="radiogroup"]');
      // Direct button children — the `:scope > button` equivalent without
      // a scoped selector (jsdom's scoped-selector matching is unreliable).
      const options = group
        ? Array.from(group.children).filter(
            (child): child is HTMLElement => child instanceof HTMLButtonElement,
          )
        : [];
      options[n - 1]?.focus();
      return true;
    }
  }

  // 2. Session Overview row.
  const viewport = document.querySelector(
    '[data-web-shell-session-table-viewport]',
  );
  if (isVisible(viewport)) {
    consume(e);
    viewport.querySelectorAll<HTMLElement>('tbody tr')[n - 1]?.click();
    return true;
  }

  // 3. Pinned section (without Shift).
  if (!shift) {
    const header = findPinnedHeader();
    if (header) {
      const wrapper = header.parentElement;
      if (wrapper) {
        if (header.getAttribute('aria-expanded') === 'false') {
          header.click();
          consume(e);
          return true;
        }
        const list = wrapper.nextElementSibling;
        const row = isVisible(list)
          ? list.querySelectorAll<HTMLElement>('div[role="button"]')[n - 1]
          : undefined;
        if (row) {
          row.click();
          consume(e);
          return true;
        }
      }
      // The section is present but nothing matches: leave the key
      // unconsumed and do not touch the panes.
      return false;
    }
  }

  // 4. Split pane + composer.
  const panes = document.querySelectorAll<HTMLElement>(
    '[data-pane-session-id]',
  );
  if (panes.length > 1) {
    consume(e);
    const pane = panes[n - 1];
    if (pane) focusPaneComposer(pane);
    return true;
  }
  return false;
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
 * bulk-actions group (the first DIV child of the Overview footer with
 * four or more direct button children) gets its last button — "Open in
 * Split" — clicked; with no rows selected there is no group and the key
 * is swallowed.
 */
export function pressSelectedRowsSplit(e: KeyboardEvent): boolean {
  const viewport = document.querySelector(
    '[data-web-shell-session-table-viewport]',
  );
  if (!isVisible(viewport)) return false;
  consume(e);
  const footer = document.querySelector('[data-web-shell-session-footer]');
  if (!footer) return true;
  for (const child of Array.from(footer.children)) {
    if (child.tagName !== 'DIV') continue;
    const buttons = Array.from(child.children).filter(
      (button): button is HTMLElement => button instanceof HTMLButtonElement,
    );
    if (buttons.length >= 4) {
      buttons[buttons.length - 1].click();
      break;
    }
  }
  return true;
}

/**
 * Cmd/Ctrl+T (without Shift) — the two-stage "new task" chord: on a
 * session screen it presses the "New task" button, on the new-task
 * screen it opens the workspace picker. When the session screen offers
 * no eligible button the key stays unconsumed and the picker stage is
 * not attempted.
 */
export function pressNewTask(e: KeyboardEvent): boolean {
  if (window.location.pathname.startsWith('/session/')) {
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
 */
export function openRadixTrigger(el: HTMLElement): void {
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
