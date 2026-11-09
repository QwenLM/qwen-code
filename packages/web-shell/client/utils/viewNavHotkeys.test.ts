// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hideNavDigitPreview,
  isOverviewCheckboxChord,
  modifierDigit,
  pressNewTask,
  pressNavigationDigit,
  pressOverviewRowCheckbox,
  pressPaneMaximizeToggle,
  pressSelectedRowsSplit,
  showNavDigitPreview,
} from './viewNavHotkeys';

// jsdom has no PointerEvent constructor; the workspace picker opens on a
// primary pointerdown (openRadixTrigger), so provide one that keeps the
// pointer fields the tests assert on.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? false;
  }
}
if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

// jsdom has no layout: offsetWidth is 0 on every element, so fixtures set it
// explicitly — the same visibility signal the chords read in a real browser.
function setWidth(el: Element, width: number): void {
  Object.defineProperty(el, 'offsetWidth', {
    configurable: true,
    value: width,
  });
}

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, ...init });
}

afterEach(() => {
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/');
});

// Session Overview table with N rows; each row may carry a checkbox. The
// checkbox is the production shape — the Radix Checkbox renders a
// <button role="checkbox" aria-checked> (no `checked` property).
// emptyRow appends DataTable's empty-state row (data-slot
// "data-table-empty"), which the panel renders when no row matches.
function makeOverviewRows(
  n: number,
  opts: { visible?: boolean; checkboxes?: boolean; emptyRow?: boolean } = {},
): { clicks: number[]; checkboxClicks: number[]; emptyClicks: number[] } {
  const clicks: number[] = [];
  const checkboxClicks: number[] = [];
  const emptyClicks: number[] = [];
  const viewport = document.createElement('div');
  viewport.setAttribute('data-web-shell-session-table-viewport', '');
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    tr.addEventListener('click', () => clicks.push(i + 1));
    if (opts.checkboxes !== false) {
      const cb = document.createElement('button');
      cb.type = 'button';
      cb.setAttribute('role', 'checkbox');
      cb.setAttribute('aria-checked', 'false');
      cb.addEventListener('click', (ev) => {
        // The real checkbox cell stops the row's click (SessionOverviewPanel).
        ev.stopPropagation();
        cb.setAttribute(
          'aria-checked',
          String(cb.getAttribute('aria-checked') !== 'true'),
        );
        checkboxClicks.push(i + 1);
      });
      tr.appendChild(cb);
    }
    tbody.appendChild(tr);
  }
  if (opts.emptyRow) {
    const empty = document.createElement('tr');
    empty.setAttribute('data-slot', 'data-table-empty');
    const td = document.createElement('td');
    td.textContent = 'No results';
    empty.appendChild(td);
    empty.addEventListener('click', () => emptyClicks.push(1));
    tbody.appendChild(empty);
  }
  table.appendChild(tbody);
  viewport.appendChild(table);
  setWidth(viewport, opts.visible === false ? 0 : 800);
  document.body.appendChild(viewport);
  return { clicks, checkboxClicks, emptyClicks };
}

// A non-modal popover carrying role="dialog" (SessionDetailsTooltip, the
// Overview's workspace filter). Covering modals are App's guard; the
// module must not treat such a popover as one.
function makePopover(): Element {
  const popover = document.createElement('div');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('data-web-shell-session-details-content', '');
  document.body.appendChild(popover);
  return popover;
}

// Overview footer with a bulk-actions group: a DIV child of the footer
// with button children. SessionOverviewPanel marks "Open in Split" with
// data-web-shell-session-split-button; the fixture marks the last button
// the same way (markLast: false reproduces an unmarked group, as when the
// panel renders no split button).
function makeBulkGroup(n: number, opts: { markLast?: boolean } = {}): number[] {
  const clicks: number[] = [];
  const footer = document.createElement('div');
  footer.setAttribute('data-web-shell-session-footer', '');
  const group = document.createElement('div');
  for (let i = 0; i < n; i++) {
    const button = document.createElement('button');
    if (i === n - 1 && opts.markLast !== false) {
      button.setAttribute('data-web-shell-session-split-button', '');
    }
    button.addEventListener('click', () => clicks.push(i + 1));
    group.appendChild(button);
  }
  footer.appendChild(group);
  document.body.appendChild(footer);
  return clicks;
}

// Split panes: focusable groups with a composer inside. composer: 'cm' (a
// .cm-content contenteditable inside the composer container — the desktop
// shape), 'container' (no .cm-content — the mobile shape), 'none'.
function makePanes(
  n: number,
  opts: { composer?: 'cm' | 'container' | 'none'; maximize?: boolean } = {},
): Element[] {
  const composer = opts.composer ?? 'cm';
  const panes: Element[] = [];
  for (let i = 0; i < n; i++) {
    const pane = document.createElement('div');
    pane.setAttribute('data-pane-session-id', `s${i + 1}`);
    pane.tabIndex = -1;
    if (opts.maximize !== false) {
      const button = document.createElement('button');
      button.setAttribute('data-web-shell-pane-maximize-button', '');
      pane.appendChild(button);
    }
    if (composer !== 'none') {
      const container = document.createElement('div');
      container.setAttribute('data-web-shell-composer-editor', '');
      if (composer === 'cm') {
        const content = document.createElement('div');
        content.className = 'cm-content';
        content.contentEditable = 'true';
        // jsdom cannot focus contenteditable without a tabindex; the real
        // .cm-content is focusable in browsers — the shim keeps that.
        content.tabIndex = -1;
        container.appendChild(content);
      }
      pane.appendChild(container);
    }
    setWidth(pane, 800);
    document.body.appendChild(pane);
    panes.push(pane);
  }
  return panes;
}

function paneComposer(pane: Element): Element {
  return (
    pane.querySelector('[data-web-shell-composer-editor] .cm-content') ??
    pane.querySelector('[data-web-shell-composer-editor]')!
  );
}

// Approval cards, nested in the given pane (in the app the card renders
// inside its pane's message list, so the "card containing the focus" check
// is a real DOM containment). buttons: number of options, null = no
// option group.
function makeApprovalPanels(
  specs: Array<{
    visible?: boolean;
    pane?: number;
    buttons?: number | null;
    disabled?: number[];
  }>,
  panes: Element[] = [],
): Element[] {
  return specs.map((spec) => {
    const panel = document.createElement('div');
    panel.setAttribute('data-web-shell-permission-panel', '');
    if (spec.buttons != null) {
      const group = document.createElement('div');
      group.setAttribute('role', 'radiogroup');
      for (let i = 0; i < spec.buttons; i++) {
        const option = document.createElement('button');
        // 1-based positions, as on the card.
        if (spec.disabled?.includes(i + 1)) option.disabled = true;
        group.appendChild(option);
      }
      panel.appendChild(group);
    }
    setWidth(panel, spec.visible === false ? 0 : 800);
    (spec.pane != null ? panes[spec.pane - 1] : document.body).appendChild(
      panel,
    );
    return panel;
  });
}

// The Pinned section: a header button whose wrapper's next sibling is the
// row list. WebShellSidebar marks the header with
// data-web-shell-pinned-header; the fixture does the same (marked: false
// reproduces an unmarked section).
function makePinned(opts: {
  label?: string | null;
  expanded?: boolean;
  rows?: number;
  visible?: boolean;
  headerVisible?: boolean;
  marked?: boolean;
  // The compact shell's closed drawer: laid out (non-zero widths) but
  // under an ancestor with `visibility: hidden`.
  inHiddenDrawer?: boolean;
}): { rowClicks: number[]; headerClicks: number[]; section: Element } {
  const rowClicks: number[] = [];
  const headerClicks: number[] = [];
  const section = document.createElement('div');
  const wrapper = document.createElement('div');
  const header = document.createElement('button');
  if (opts.marked !== false) {
    header.setAttribute('data-web-shell-pinned-header', '');
  }
  header.setAttribute(
    'aria-expanded',
    opts.expanded === false ? 'false' : 'true',
  );
  header.addEventListener('click', () => headerClicks.push(1));
  if (opts.label != null) {
    const label = document.createElement('span');
    label.textContent = opts.label;
    header.appendChild(label);
  }
  wrapper.appendChild(header);
  section.appendChild(wrapper);
  const list = document.createElement('div');
  for (let i = 0; i < (opts.rows ?? 0); i++) {
    const row = document.createElement('div');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('click', () => rowClicks.push(i + 1));
    list.appendChild(row);
  }
  setWidth(list, opts.visible === false ? 0 : 800);
  section.appendChild(list);
  setWidth(header, opts.headerVisible === false ? 0 : 800);
  if (opts.inHiddenDrawer) {
    const drawer = document.createElement('div');
    drawer.style.visibility = 'hidden';
    drawer.appendChild(section);
    document.body.appendChild(drawer);
  } else {
    document.body.appendChild(section);
  }
  return { rowClicks, headerClicks, section };
}

// A Radix-like dropdown trigger: a bare .click() (detail 0, no pointer
// events) does not open the menu; a primary pointerdown does.
// Like Radix (onOpenToggle), a primary pointerdown toggles the menu and the
// trigger reflects the state in aria-expanded / data-state.
function makeRadixTrigger(opts: { open?: boolean } = {}): {
  el: HTMLButtonElement;
  events: string[];
  opened: () => boolean;
} {
  const el = document.createElement('button');
  el.setAttribute('data-web-shell-workspace-select-trigger', '');
  setWidth(el, 200);
  const events: string[] = [];
  let open = false;
  const setOpen = (next: boolean): void => {
    open = next;
    el.setAttribute('aria-expanded', String(next));
    el.setAttribute('data-state', next ? 'open' : 'closed');
  };
  setOpen(opts.open ?? false);
  el.addEventListener('pointerdown', (event) => {
    const pe = event as PointerEvent;
    events.push('pointerdown');
    if (pe.isPrimary && pe.pointerType === 'mouse') setOpen(!open);
  });
  el.addEventListener('mousedown', () => events.push('mousedown'));
  el.addEventListener('pointerup', () => events.push('pointerup'));
  el.addEventListener('mouseup', () => events.push('mouseup'));
  document.body.appendChild(el);
  return { el, events, opened: () => open };
}

function makeEligibleButton(
  attr: string,
  opts: { visible?: boolean; disabled?: boolean; dataDisabled?: boolean } = {},
): HTMLButtonElement {
  const el = document.createElement('button');
  el.setAttribute(attr, '');
  if (opts.disabled) el.disabled = true;
  if (opts.dataDisabled) el.setAttribute('data-disabled', '');
  setWidth(el, opts.visible === false ? 0 : 200);
  document.body.appendChild(el);
  return el;
}

describe('modifierDigit / isOverviewCheckboxChord', () => {
  it('reads the main number row by code, not key', () => {
    for (let n = 1; n <= 9; n++) {
      expect(modifierDigit(press({ code: `Digit${n}` }))).toBe(n);
    }
    // AZERTY: e.key is '&' but the physical key is Digit1.
    expect(modifierDigit(press({ code: 'Digit1', key: '&' }))).toBe(1);
    expect(modifierDigit(press({ code: 'Digit0' }))).toBe(0);
    expect(modifierDigit(press({ code: 'Numpad1' }))).toBe(0);
    expect(modifierDigit(press({ code: 'KeyA' }))).toBe(0);
  });

  it('detects the Option+Shift checkbox chord (macOS) only', () => {
    expect(
      isOverviewCheckboxChord(
        press({ code: 'Digit1', altKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    // No modifier key, and never with Cmd/Ctrl:
    expect(
      isOverviewCheckboxChord(press({ code: 'Digit1', altKey: true })),
    ).toBe(false);
    expect(
      isOverviewCheckboxChord(press({ code: 'Digit1', shiftKey: true })),
    ).toBe(false);
    expect(
      isOverviewCheckboxChord(
        press({ code: 'Digit1', altKey: true, shiftKey: true, metaKey: true }),
      ),
    ).toBe(false);
    expect(
      isOverviewCheckboxChord(
        press({ code: 'Digit1', altKey: true, shiftKey: true, ctrlKey: true }),
      ),
    ).toBe(false);
    // Digit0 / Numpad are not rows.
    expect(
      isOverviewCheckboxChord(
        press({ code: 'Digit0', altKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(
      isOverviewCheckboxChord(
        press({ code: 'Numpad1', altKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });
});

describe('pressOverviewRowCheckbox (Option+Shift+1..9)', () => {
  it('toggles the Nth row checkbox (the role="checkbox" button)', () => {
    const { checkboxClicks } = makeOverviewRows(9);
    for (const n of [2, 4, 9]) {
      const event = press({ code: `Digit${n}`, altKey: true, shiftKey: true });
      expect(pressOverviewRowCheckbox(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      // Consumed means stopped too: the key must not reach React handlers.
      expect(event.cancelBubble).toBe(true);
    }
    expect(checkboxClicks).toEqual([2, 4, 9]);
    const boxes = document.querySelectorAll('[role="checkbox"]');
    expect(boxes[1].getAttribute('aria-checked')).toBe('true');
    expect(boxes[0].getAttribute('aria-checked')).toBe('false');
  });

  it('still toggles while a non-modal role="dialog" popover is open', () => {
    // Covering modals are App's guard (the modal primitives); a hover
    // popover with role="dialog" must not disable the chord.
    const { checkboxClicks } = makeOverviewRows(9);
    makePopover();
    const event = press({ code: 'Digit2', altKey: true, shiftKey: true });
    expect(pressOverviewRowCheckbox(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(checkboxClicks).toEqual([2]);
  });

  it('leaves the key unconsumed when the table is hidden', () => {
    const hidden = makeOverviewRows(9, { visible: false });
    const event = press({ code: 'Digit4', altKey: true, shiftKey: true });
    expect(pressOverviewRowCheckbox(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(hidden.checkboxClicks).toEqual([]);
  });

  it('leaves the key unconsumed when the Nth row is absent', () => {
    const few = makeOverviewRows(3);
    const event = press({ code: 'Digit7', altKey: true, shiftKey: true });
    expect(pressOverviewRowCheckbox(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(few.checkboxClicks).toEqual([]);
  });

  it('does not count the empty-state row as a row', () => {
    const { emptyClicks } = makeOverviewRows(0, { emptyRow: true });
    const event = press({ code: 'Digit1', altKey: true, shiftKey: true });
    expect(pressOverviewRowCheckbox(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(emptyClicks).toEqual([]);
  });

  it('consumes the key when the row exists but has no checkbox', () => {
    const { checkboxClicks } = makeOverviewRows(3, { checkboxes: false });
    const event = press({ code: 'Digit2', altKey: true, shiftKey: true });
    expect(pressOverviewRowCheckbox(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(checkboxClicks).toEqual([]);
  });
});

describe('pressSelectedRowsSplit (Cmd/Ctrl+Shift+\\)', () => {
  it('clicks the marked button (Open in Split)', () => {
    makeOverviewRows(3);
    const clicks = makeBulkGroup(4);
    let event = press({ code: 'Backslash', metaKey: true, shiftKey: true });
    expect(pressSelectedRowsSplit(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(event.cancelBubble).toBe(true);
    event = press({ code: 'Backslash', ctrlKey: true, shiftKey: true });
    expect(pressSelectedRowsSplit(event)).toBe(true);
    expect(clicks).toEqual([4, 4]);
  });

  it('clicks the marked button, not merely the last one', () => {
    // A fifth button joins the group after "Open in Split" — the mark
    // keeps the click on the right button.
    makeOverviewRows(3);
    const clicks = makeBulkGroup(4);
    const footer = document.querySelector('[data-web-shell-session-footer]')!;
    const group = footer.firstElementChild!;
    let extraClicked = 0;
    const extra = document.createElement('button');
    extra.addEventListener('click', () => extraClicked++);
    group.appendChild(extra);
    const event = press({ code: 'Backslash', metaKey: true, shiftKey: true });
    expect(pressSelectedRowsSplit(event)).toBe(true);
    expect(clicks).toEqual([4]);
    expect(extraClicked).toBe(0);
  });

  it('swallows the key while the table is visible but no button is marked', () => {
    makeOverviewRows(3); // no footer at all
    let event = press({ code: 'Backslash', metaKey: true, shiftKey: true });
    expect(pressSelectedRowsSplit(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);

    // A group without the mark (no selection renders no split button)
    // leaves the key swallowed.
    document.querySelector('[data-web-shell-session-footer]')?.remove();
    const clicks = makeBulkGroup(3, { markLast: false });
    event = press({ code: 'Backslash', metaKey: true, shiftKey: true });
    expect(pressSelectedRowsSplit(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(clicks).toEqual([]);
  });

  it('ignores unmarked DIVs before the marked group', () => {
    makeOverviewRows(3);
    const groupClicks = makeBulkGroup(4);
    const footer = document.querySelector('[data-web-shell-session-footer]')!;
    // An unmarked 4-button DIV before the group does not win the click.
    const early = document.createElement('div');
    const earlyClicks: number[] = [];
    for (let i = 0; i < 4; i++) {
      const button = document.createElement('button');
      button.addEventListener('click', () => earlyClicks.push(i + 1));
      early.appendChild(button);
    }
    footer.insertBefore(early, footer.firstChild);
    const event = press({ code: 'Backslash', metaKey: true, shiftKey: true });
    expect(pressSelectedRowsSplit(event)).toBe(true);
    expect(earlyClicks).toEqual([]);
    expect(groupClicks).toEqual([4]);
  });

  it('leaves the key unconsumed while the table is hidden', () => {
    makeOverviewRows(3, { visible: false });
    const clicks = makeBulkGroup(4);
    const event = press({ code: 'Backslash', metaKey: true, shiftKey: true });
    expect(pressSelectedRowsSplit(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(clicks).toEqual([]);
  });
});

describe('pressPaneMaximizeToggle (Cmd/Ctrl+Shift+F)', () => {
  function maximizeClicks(panes: Element[]): number[] {
    const clicks: number[] = [];
    panes.forEach((pane, i) =>
      pane
        .querySelector('[data-web-shell-pane-maximize-button]')!
        .addEventListener('click', () => clicks.push(i + 1)),
    );
    return clicks;
  }

  it('clicks the focused pane maximize button', () => {
    const panes = makePanes(2);
    const clicks = maximizeClicks(panes);
    paneComposer(panes[0]).focus();
    const first = press({
      code: 'KeyF',
      key: 'f',
      metaKey: true,
      shiftKey: true,
    });
    expect(pressPaneMaximizeToggle(first)).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    expect(first.cancelBubble).toBe(true);
    paneComposer(panes[1]).focus();
    const second = press({
      code: 'KeyF',
      key: 'f',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(pressPaneMaximizeToggle(second)).toBe(true);
    expect(clicks).toEqual([1, 2]);
  });

  it('leaves the key unconsumed without a focused, visible pane button', () => {
    const panes = makePanes(2);
    // No pane focus (focus is on the body).
    let event = press({ code: 'KeyF', metaKey: true, shiftKey: true });
    expect(pressPaneMaximizeToggle(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    // Focused, but the pane is hidden.
    paneComposer(panes[0]).focus();
    setWidth(panes[0], 0);
    event = press({ code: 'KeyF', metaKey: true, shiftKey: true });
    expect(pressPaneMaximizeToggle(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    // Focused visible pane without a maximize button (single-pane view).
    const bare = makePanes(2, { maximize: false });
    paneComposer(bare[0]).focus();
    event = press({ code: 'KeyF', metaKey: true, shiftKey: true });
    expect(pressPaneMaximizeToggle(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('pressNewTask (Cmd/Ctrl+T)', () => {
  it('opens the workspace picker on the new-task screen by pointer sequence', () => {
    window.history.pushState({}, '', '/');
    const radix = makeRadixTrigger();
    // Control: a bare .click() does not open the Radix trigger.
    radix.el.click();
    expect(radix.opened()).toBe(false);
    const event = press({ code: 'KeyT', key: 't', metaKey: true });
    expect(pressNewTask(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(radix.opened()).toBe(true);
    expect(radix.events).toEqual([
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
    ]);
  });

  it('leaves an already open picker open', () => {
    // The trigger toggles on pointerdown; a second Cmd/Ctrl+T (or one
    // after opening the picker by mouse) must not close it.
    window.history.pushState({}, '', '/');
    const radix = makeRadixTrigger({ open: true });
    const event = press({ code: 'KeyT', key: 't', metaKey: true });
    expect(pressNewTask(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(radix.opened()).toBe(true);
    expect(radix.events).toEqual([]);
  });

  it('clicks the first eligible New task button on a session screen', () => {
    window.history.pushState({}, '', '/session/abc123');
    const button = makeEligibleButton('data-web-shell-new-task-button');
    const clicks: number[] = [];
    button.addEventListener('click', () => clicks.push(1));
    const radix = makeRadixTrigger();
    const event = press({ code: 'KeyT', key: 't', metaKey: true });
    expect(pressNewTask(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(event.cancelBubble).toBe(true);
    expect(clicks).toEqual([1]);
    // The picker stage is not attempted on a session screen.
    expect(radix.opened()).toBe(false);
    const ctrl = press({ code: 'KeyT', key: 't', ctrlKey: true });
    expect(pressNewTask(ctrl)).toBe(true);
    expect(clicks).toEqual([1, 1]);
  });

  it('recognises a session screen under a base path', () => {
    // The session URL is `${basePath}/session/<id>`.
    window.history.pushState({}, '', '/agentic-code/session/abc123');
    const button = makeEligibleButton('data-web-shell-new-task-button');
    const clicks: number[] = [];
    button.addEventListener('click', () => clicks.push(1));
    const radix = makeRadixTrigger();
    const event = press({ code: 'KeyT', key: 't', metaKey: true });
    expect(pressNewTask(event)).toBe(true);
    expect(clicks).toEqual([1]);
    expect(radix.opened()).toBe(false);
  });

  it('skips hidden, disabled, and data-disabled candidates', () => {
    window.history.pushState({}, '', '/session/abc123');
    makeEligibleButton('data-web-shell-new-task-button', { visible: false });
    makeEligibleButton('data-web-shell-new-task-button', { disabled: true });
    makeEligibleButton('data-web-shell-new-task-button', {
      dataDisabled: true,
    });
    const fourth = makeEligibleButton('data-web-shell-new-task-button');
    const clicks: number[] = [];
    fourth.addEventListener('click', () => clicks.push(1));
    const event = press({ code: 'KeyT', key: 't', metaKey: true });
    expect(pressNewTask(event)).toBe(true);
    expect(clicks).toEqual([1]);
  });

  it('leaves the key unconsumed when no eligible candidate exists', () => {
    window.history.pushState({}, '', '/session/abc123');
    makeEligibleButton('data-web-shell-new-task-button', { visible: false });
    makeEligibleButton('data-web-shell-new-task-button', { disabled: true });
    let event = press({ code: 'KeyT', key: 't', metaKey: true });
    expect(pressNewTask(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);

    document.body.querySelectorAll('button').forEach((b) => b.remove());
    window.history.pushState({}, '', '/');
    makeEligibleButton('data-web-shell-workspace-select-trigger', {
      disabled: true,
    });
    event = press({ code: 'KeyT', key: 't', metaKey: true });
    expect(pressNewTask(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('prefers the picker over the New task button on the new-task screen', () => {
    window.history.pushState({}, '', '/');
    const button = makeEligibleButton('data-web-shell-new-task-button');
    const buttonClicks: number[] = [];
    button.addEventListener('click', () => buttonClicks.push(1));
    const radix = makeRadixTrigger();
    const event = press({ code: 'KeyT', key: 't', metaKey: true });
    expect(pressNewTask(event)).toBe(true);
    expect(radix.opened()).toBe(true);
    expect(buttonClicks).toEqual([]);
  });
});

describe('pressNavigationDigit (Cmd/Ctrl+1..9)', () => {
  describe('Session Overview rows', () => {
    it('clicks the Nth visible row (shift-agnostic while the table is visible)', () => {
      const { clicks, checkboxClicks } = makeOverviewRows(9);
      const events = [
        press({ code: 'Digit1', key: '1', metaKey: true }),
        press({ code: 'Digit2', key: '2', ctrlKey: true }),
        press({ code: 'Digit9', key: '9', metaKey: true }),
        // AZERTY: the physical Digit1 types '&'.
        press({ code: 'Digit1', key: '&', metaKey: true }),
        // With Shift the row is clicked too (the checkbox needs Option).
        press({ code: 'Digit2', key: '2', metaKey: true, shiftKey: true }),
      ];
      for (const event of events) {
        expect(pressNavigationDigit(event)).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(event.cancelBubble).toBe(true);
      }
      expect(clicks).toEqual([1, 2, 9, 1, 2]);
      expect(checkboxClicks).toEqual([]);
    });

    it('swallows the key with more digits than rows', () => {
      const { clicks } = makeOverviewRows(3);
      for (const shift of [false, true]) {
        const event = press({
          code: 'Digit7',
          key: '7',
          metaKey: true,
          shiftKey: shift,
        });
        expect(pressNavigationDigit(event)).toBe(true);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(clicks).toEqual([]);
    });

    it('claims the key over the empty-state row without clicking it', () => {
      // The Overview claims the digits while visible (as with fewer rows
      // than N); the "no results" row is not a row target.
      const { emptyClicks } = makeOverviewRows(0, { emptyRow: true });
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(emptyClicks).toEqual([]);
    });

    it('ignores a hidden table and falls through to the panes', () => {
      const { clicks } = makeOverviewRows(9, { visible: false });
      const panes = makePanes(2);
      const event = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(clicks).toEqual([]);
      expect(document.activeElement).toBe(
        panes[1].querySelector('[data-web-shell-composer-editor] .cm-content'),
      );
    });
  });

  describe('approval cards (without Shift)', () => {
    it('focuses the Nth option of the card containing the focus, not clicks', () => {
      const panes = makePanes(2);
      const [panel] = makeApprovalPanels(
        [{ visible: true, pane: 1, buttons: 2 }],
        panes,
      );
      const options = panel.querySelectorAll('[role="radiogroup"] > button');
      let clicks = 0;
      options.forEach((option) =>
        option.addEventListener('click', () => clicks++),
      );
      paneComposer(panes[0]).focus();
      const first = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(first)).toBe(true);
      expect(first.defaultPrevented).toBe(true);
      // ToolApproval confirms on a bare digit; stopping propagation is
      // what keeps the chord from also submitting the focused option.
      expect(first.cancelBubble).toBe(true);
      expect(document.activeElement).toBe(options[0]);
      const second = press({ code: 'Digit2', key: '2', ctrlKey: true });
      expect(pressNavigationDigit(second)).toBe(true);
      expect(document.activeElement).toBe(options[1]);
      // Focus, not click: Enter activates natively, outside the handler.
      expect(clicks).toBe(0);
    });

    it('marks the focused option for the ring and clears it on blur', () => {
      const panes = makePanes(2);
      const [panel] = makeApprovalPanels(
        [{ visible: true, pane: 1, buttons: 3 }],
        panes,
      );
      const options = panel.querySelectorAll('[role="radiogroup"] > button');
      paneComposer(panes[0]).focus();
      const first = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(first)).toBe(true);
      expect(options[0].hasAttribute('data-web-shell-hotkey-focused')).toBe(
        true,
      );
      // Moving the chord to another option clears the previous mark.
      const second = press({ code: 'Digit2', key: '2', ctrlKey: true });
      expect(pressNavigationDigit(second)).toBe(true);
      expect(options[0].hasAttribute('data-web-shell-hotkey-focused')).toBe(
        false,
      );
      expect(options[1].hasAttribute('data-web-shell-hotkey-focused')).toBe(
        true,
      );
      // Losing focus (a pointer click elsewhere) removes the ring.
      options[1].blur();
      expect(options[1].hasAttribute('data-web-shell-hotkey-focused')).toBe(
        false,
      );
    });

    it('swallows extra digits and cards without an option group', () => {
      // No panes: nothing below the card would consume, so only the
      // card's own claim can swallow the key.
      makeApprovalPanels([{ visible: true, buttons: 2 }]);
      const event = press({ code: 'Digit3', key: '3', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);

      document
        .querySelectorAll('[data-web-shell-permission-panel]')
        .forEach((p) => p.remove());
      makeApprovalPanels([{ visible: true, buttons: null }]);
      const swallow = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(swallow)).toBe(true);
      expect(swallow.defaultPrevented).toBe(true);
      expect(
        document.activeElement?.closest('[data-web-shell-permission-panel]'),
      ).toBeNull();
    });

    it('claims the key over a disabled option without marking or focusing it', () => {
      // ToolApproval disables its options while a Goal card submits.
      const [panel] = makeApprovalPanels([
        { visible: true, buttons: 2, disabled: [1] },
      ]);
      const options = panel.querySelectorAll('[role="radiogroup"] > button');
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(options[0].hasAttribute('data-web-shell-hotkey-focused')).toBe(
        false,
      );
      expect(document.activeElement).not.toBe(options[0]);
      // The enabled option is still reachable by its own position.
      const second = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(second)).toBe(true);
      expect(document.activeElement).toBe(options[1]);
    });

    it('prefers the card over the Overview, the Pinned section, and the panes', () => {
      const panes = makePanes(2);
      const overview = makeOverviewRows(9);
      const { rowClicks } = makePinned({
        label: 'Pinned',
        expanded: true,
        rows: 6,
      });
      makeApprovalPanels([{ visible: true, pane: 1, buttons: 2 }], panes);
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(
        document.activeElement?.closest('[data-web-shell-permission-panel]'),
      ).not.toBeNull();
      expect(rowClicks).toEqual([]);
      expect(overview.clicks).toEqual([]);
    });

    it('acts on the card containing the focus, not the first visible one', () => {
      const panes = makePanes(2);
      const [first, second] = makeApprovalPanels(
        [
          { visible: true, pane: 1, buttons: 2 },
          { visible: true, pane: 2, buttons: 3 },
        ],
        panes,
      );
      paneComposer(panes[1]).focus();
      const event = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(document.activeElement).toBe(
        second.querySelectorAll('[role="radiogroup"] > button')[1],
      );
      expect(first).not.toContain(document.activeElement);
    });

    it('keeps the card containing the focus over an earlier card in the same pane', () => {
      // A pane can hold several cards (an unanswered one plus a newer
      // one); the focused card wins over DOM order.
      const panes = makePanes(1);
      const [earlier, focused] = makeApprovalPanels(
        [
          { visible: true, pane: 1, buttons: 2 },
          { visible: true, pane: 1, buttons: 2 },
        ],
        panes,
      );
      const options = focused.querySelectorAll('[role="radiogroup"] > button');
      options[0].focus();
      const event = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(document.activeElement).toBe(options[1]);
      expect(earlier).not.toContain(document.activeElement);
    });

    it('falls back to the first visible card without a focused card', () => {
      const panes = makePanes(2);
      const [first, second] = makeApprovalPanels(
        [
          { visible: true, pane: 1, buttons: 2 },
          { visible: true, pane: 2, buttons: 3 },
        ],
        panes,
      );
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(document.activeElement).toBe(
        first.querySelector('[role="radiogroup"] > button'),
      );
      expect(second).not.toContain(document.activeElement);
    });

    it('picks the visible card when the focused pane card is hidden', () => {
      const panes = makePanes(2);
      const [visible] = makeApprovalPanels(
        [
          { visible: true, pane: 1, buttons: 2 },
          { visible: false, pane: 2, buttons: 3 },
        ],
        panes,
      );
      // Focus inside the second pane; its card is hidden.
      paneComposer(panes[1]).focus();
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(document.activeElement).toBe(
        visible.querySelector('[role="radiogroup"] > button'),
      );
    });

    it('ignores a hidden card, falling through to the panes', () => {
      const panes = makePanes(2);
      makeApprovalPanels([{ visible: false, pane: 1, buttons: 2 }], panes);
      const hidden = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(hidden)).toBe(true);
      expect(document.activeElement).toBe(paneComposer(panes[0]));
    });

    it('is skipped with Shift, falling through to the panes', () => {
      // A visible card: only the Shift gate keeps it out of the chain.
      const panes = makePanes(2);
      const [panel] = makeApprovalPanels(
        [{ visible: true, pane: 1, buttons: 2 }],
        panes,
      );
      const shifted = press({
        code: 'Digit2',
        key: '2',
        ctrlKey: true,
        shiftKey: true,
      });
      expect(pressNavigationDigit(shifted)).toBe(true);
      expect(document.activeElement).toBe(paneComposer(panes[1]));
      expect(panel).not.toContain(document.activeElement);
    });
  });

  describe('Pinned section (without Shift)', () => {
    it('clicks the Nth pinned row while the Overview is closed', () => {
      makePanes(2);
      const { rowClicks } = makePinned({
        label: 'Pinned',
        expanded: true,
        rows: 6,
      });
      const one = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(one)).toBe(true);
      expect(one.cancelBubble).toBe(true);
      const four = press({ code: 'Digit4', key: '4', ctrlKey: true });
      expect(pressNavigationDigit(four)).toBe(true);
      expect(rowClicks).toEqual([1, 4]);
      // The pane is not touched while the section matches.
      expect(
        document.activeElement?.closest('[data-pane-session-id]'),
      ).toBeNull();
    });

    it('leaves the key unconsumed with more digits than pinned rows', () => {
      makePanes(2);
      const { rowClicks, headerClicks } = makePinned({
        label: 'Pinned',
        expanded: true,
        rows: 6,
      });
      const event = press({ code: 'Digit7', key: '7', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(rowClicks).toEqual([]);
      expect(headerClicks).toEqual([]);
      // And the panes stay untouched: the section exists.
      expect(
        document.activeElement?.closest('[data-pane-session-id]'),
      ).toBeNull();
    });

    it('expands a collapsed section on the first press', () => {
      makePanes(2);
      const collapsed = makePinned({
        label: 'Pinned',
        expanded: false,
        rows: 6,
      });
      const event = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(collapsed.headerClicks).toEqual([1]);
      expect(collapsed.rowClicks).toEqual([]);
    });

    it('wins over the panes, loses to the Overview', () => {
      makePanes(2);
      const { rowClicks } = makePinned({
        label: 'Pinned',
        expanded: true,
        rows: 6,
      });
      const event = press({ code: 'Digit3', key: '3', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(rowClicks).toEqual([3]);
      expect(
        document.activeElement?.closest('[data-pane-session-id]'),
      ).toBeNull();

      const overview = makeOverviewRows(9);
      const overviewEvent = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(overviewEvent)).toBe(true);
      expect(overview.clicks).toEqual([2]);
      expect(rowClicks).toEqual([3]);
    });

    it('is skipped with Shift, falling through to the panes', () => {
      const panes = makePanes(2);
      const { rowClicks } = makePinned({
        label: 'Pinned',
        expanded: true,
        rows: 6,
      });
      const event = press({
        code: 'Digit2',
        key: '2',
        ctrlKey: true,
        shiftKey: true,
      });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(rowClicks).toEqual([]);
      expect(document.activeElement).toBe(paneComposer(panes[1]));
    });

    it('treats a hidden section (closed sidebar) as absent', () => {
      const panes = makePanes(2);
      makePinned({
        label: 'Pinned',
        expanded: true,
        rows: 6,
        headerVisible: false,
      });
      const event = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(document.activeElement).toBe(paneComposer(panes[1]));
    });

    it('finds the marked header whatever the locale label reads', () => {
      const panes = makePanes(2);
      // ru is user-selectable and currently reads the English label
      // through the i18n fallback; a future ru translation must keep
      // working, so the lookup keys off the mark, not the label.
      const ru = makePinned({ label: 'Закреплённые', expanded: true, rows: 6 });
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(ru.rowClicks).toEqual([1]);
      ru.section.remove();

      const zh = makePinned({ label: '置顶', expanded: true, rows: 6 });
      const zhEvent = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(zhEvent)).toBe(true);
      expect(zh.rowClicks).toEqual([1]);
      zh.section.remove();

      const other = makePinned({
        label: 'Recent',
        expanded: true,
        rows: 6,
        marked: false,
      });
      const event2 = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event2)).toBe(true);
      expect(other.rowClicks).toEqual([]);
      expect(document.activeElement).toBe(paneComposer(panes[0]));
    });

    it('treats a section in the closed (visibility: hidden) drawer as absent', () => {
      // The compact shell keeps the closed drawer laid out under
      // visibility: hidden — widths are non-zero, the rows are invisible.
      const panes = makePanes(2);
      const { rowClicks } = makePinned({
        label: 'Pinned',
        expanded: true,
        rows: 6,
        inHiddenDrawer: true,
      });
      const event = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(rowClicks).toEqual([]);
      expect(document.activeElement).toBe(paneComposer(panes[1]));
    });

    it('treats an unmarked section as absent', () => {
      const panes = makePanes(2);
      makePinned({ label: 'Pinned', expanded: true, rows: 6, marked: false });
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(document.activeElement).toBe(paneComposer(panes[0]));
    });

    it('leaves an expanded section with a hidden list unconsumed', () => {
      // Panes are present, so a fall-through would consume and focus one.
      makePanes(2);
      const { rowClicks, headerClicks } = makePinned({
        label: 'Pinned',
        expanded: true,
        rows: 6,
        visible: false,
      });
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(rowClicks).toEqual([]);
      expect(headerClicks).toEqual([]);
      expect(
        document.activeElement?.closest('[data-pane-session-id]'),
      ).toBeNull();
    });
  });

  describe('split panes (last priority)', () => {
    it('focuses the Nth pane and its composer', () => {
      const panes = makePanes(2);
      const events = [
        press({ code: 'Digit1', key: '1', metaKey: true }),
        press({ code: 'Digit2', key: '2', ctrlKey: true }),
        press({ code: 'Digit2', key: '2', ctrlKey: true, shiftKey: true }),
      ];
      for (const event of events) {
        expect(pressNavigationDigit(event)).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(event.cancelBubble).toBe(true);
      }
      expect(document.activeElement).toBe(paneComposer(panes[1]));
    });

    it('numbers only the visible panes (a maximized sibling hides the rest)', () => {
      const panes = makePanes(3);
      setWidth(panes[0], 0);
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(document.activeElement).toBe(paneComposer(panes[1]));
      const second = press({ code: 'Digit2', key: '2', metaKey: true });
      expect(pressNavigationDigit(second)).toBe(true);
      expect(document.activeElement).toBe(paneComposer(panes[2]));
    });

    it('leaves the key unconsumed with a single visible pane', () => {
      const panes = makePanes(2);
      setWidth(panes[1], 0);
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(document.body);
    });

    it('falls back to the composer container without .cm-content', () => {
      const panes = makePanes(2, { composer: 'container' });
      const container = panes[0].querySelector(
        '[data-web-shell-composer-editor]',
      )!;
      const focusSpy = vi.spyOn(container, 'focus');
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      // The plain container is not focusable, so the focus stays on the pane.
      expect(document.activeElement).toBe(panes[0]);
      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('focuses only the pane without a composer', () => {
      const panes = makePanes(2, { composer: 'none' });
      const event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(document.activeElement).toBe(panes[0]);
    });

    it('swallows the key with more digits than panes', () => {
      makePanes(3);
      const event = press({ code: 'Digit7', key: '7', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(
        document.activeElement?.closest('[data-pane-session-id]'),
      ).toBeNull();
    });

    it('needs at least two panes, and nothing else, to act', () => {
      makePanes(1);
      let event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);

      document.querySelector('[data-pane-session-id]')?.remove();
      event = press({ code: 'Digit1', key: '1', metaKey: true });
      expect(pressNavigationDigit(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });
  });
});

describe('nav digit preview (Cmd/Ctrl hold)', () => {
  // The current badge set in document order: target element + the number.
  function badges(): Array<{ el: Element; n: string }> {
    return Array.from(
      document.querySelectorAll('[data-web-shell-nav-preview]'),
    ).map((el) => ({
      el,
      n: el.getAttribute('data-web-shell-nav-preview') ?? '',
    }));
  }

  it('numbers nothing on an empty surface and injects the style once', () => {
    showNavDigitPreview();
    expect(badges()).toEqual([]);
    expect(
      document.querySelectorAll('style#webShellNavPreviewStyle').length,
    ).toBe(1);
    // Repeat show/hide cycles keep exactly one style element.
    for (let i = 0; i < 5; i++) {
      showNavDigitPreview();
      hideNavDigitPreview();
    }
    expect(
      document.querySelectorAll('style#webShellNavPreviewStyle').length,
    ).toBe(1);
  });

  it('numbers the expanded Pinned rows 1..N in DOM order', () => {
    const { section } = makePinned({
      label: 'Pinned',
      expanded: true,
      rows: 5,
    });
    showNavDigitPreview();
    const rows = section.querySelectorAll('div[role="button"]');
    expect(badges().map((b) => b.el)).toEqual(Array.from(rows));
    expect(badges().map((b) => b.n)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('numbers at most nine targets', () => {
    const { section } = makePinned({
      label: 'Pinned',
      expanded: true,
      rows: 12,
    });
    showNavDigitPreview();
    expect(badges().map((b) => b.n)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    // The tenth row stays unnumbered — the chord has no key for it.
    expect(
      section
        .querySelectorAll('div[role="button"]')[9]
        .hasAttribute('data-web-shell-nav-preview'),
    ).toBe(false);
  });

  it('numbers nothing for a collapsed section, without falling through to the panes', () => {
    const panes = makePanes(2);
    makePinned({ label: 'Pinned', expanded: false, rows: 5 });
    showNavDigitPreview();
    expect(badges()).toEqual([]);
    panes.forEach((p) =>
      expect(p.hasAttribute('data-web-shell-nav-preview')).toBe(false),
    );
  });

  it('numbers nothing for an expanded section with a hidden list, without falling through', () => {
    const panes = makePanes(2);
    makePinned({
      label: 'Pinned',
      expanded: true,
      rows: 4,
      visible: false,
    });
    showNavDigitPreview();
    expect(badges()).toEqual([]);
    panes.forEach((p) =>
      expect(p.hasAttribute('data-web-shell-nav-preview')).toBe(false),
    );
  });

  it('numbers the Pinned rows, not the panes, when both are present', () => {
    const panes = makePanes(2);
    const { section } = makePinned({
      label: 'Pinned',
      expanded: true,
      rows: 3,
    });
    showNavDigitPreview();
    expect(badges().map((b) => b.el)).toEqual(
      Array.from(section.querySelectorAll('div[role="button"]')),
    );
    panes.forEach((p) =>
      expect(p.hasAttribute('data-web-shell-nav-preview')).toBe(false),
    );
  });

  it('numbers the split pane roots when they are the navigation target', () => {
    const panes = makePanes(3);
    showNavDigitPreview();
    expect(badges().map((b) => b.el)).toEqual(panes);
    panes[0].remove();
    panes[1].remove();
    showNavDigitPreview();
    // A single pane is not a navigation target (the chord needs two).
    expect(badges()).toEqual([]);
  });

  it('numbers the Overview rows on their last cell', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-web-shell-session-table-viewport', '');
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    for (let i = 0; i < 3; i++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < 3; c++) {
        const td = document.createElement('td');
        td.textContent = `${i}.${c}`;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    viewport.appendChild(table);
    setWidth(viewport, 800);
    document.body.appendChild(viewport);
    showNavDigitPreview();
    const rows = viewport.querySelectorAll('tbody tr');
    expect(badges().map((b) => b.el)).toEqual(
      Array.from(rows).map((r) => r.querySelector('td:last-child')!),
    );
    expect(badges().map((b) => b.n)).toEqual(['1', '2', '3']);
  });

  it('claims the Overview table even with no rows (the panes stay unnumbered)', () => {
    const panes = makePanes(2);
    const viewport = document.createElement('div');
    viewport.setAttribute('data-web-shell-session-table-viewport', '');
    viewport.appendChild(document.createElement('table'));
    setWidth(viewport, 800);
    document.body.appendChild(viewport);
    showNavDigitPreview();
    expect(badges()).toEqual([]);
    panes.forEach((p) =>
      expect(p.hasAttribute('data-web-shell-nav-preview')).toBe(false),
    );
  });

  it('numbers the approval options when the card wins', () => {
    const panes = makePanes(2);
    makePinned({ label: 'Pinned', expanded: true, rows: 3 });
    const [panel] = makeApprovalPanels(
      [{ visible: true, pane: 1, buttons: 4 }],
      panes,
    );
    showNavDigitPreview();
    const options = panel.querySelectorAll('[role="radiogroup"] button');
    expect(badges().map((b) => b.el)).toEqual(Array.from(options));
    expect(badges().map((b) => b.n)).toEqual(['1', '2', '3', '4']);
  });

  it('claims the approval card even without an option group (no fall-through)', () => {
    const panes = makePanes(2);
    makePinned({ label: 'Pinned', expanded: true, rows: 3 });
    makeApprovalPanels([{ visible: true, pane: 1, buttons: null }], panes);
    showNavDigitPreview();
    expect(badges()).toEqual([]);
  });

  it('still numbers the targets while a non-modal role="dialog" popover is open', () => {
    // Covering modals are App's guard; a hover popover must not blank the
    // preview while the chord itself still acts.
    const { section } = makePinned({
      label: 'Pinned',
      expanded: true,
      rows: 3,
    });
    makePopover();
    showNavDigitPreview();
    const rows = section.querySelectorAll('div[role="button"]');
    expect(badges().map((b) => b.el)).toEqual(Array.from(rows));
  });

  it('numbers the Shift chain when Shift is held (no card, no Pinned rows)', () => {
    const panes = makePanes(2);
    makePinned({ label: 'Pinned', expanded: true, rows: 3 });
    makeApprovalPanels([{ visible: true, pane: 1, buttons: 2 }], panes);
    showNavDigitPreview({ shift: true });
    // The same targets pressNavigationDigit acts on with Shift: the panes.
    expect(badges().map((b) => b.el)).toEqual(panes);
    const press2 = press({
      code: 'Digit2',
      key: '2',
      metaKey: true,
      shiftKey: true,
    });
    expect(pressNavigationDigit(press2)).toBe(true);
    expect(document.activeElement).toBe(paneComposer(panes[1]));
  });

  it('leaves a disabled approval option unnumbered, keeping the positions', () => {
    const [panel] = makeApprovalPanels([
      { visible: true, buttons: 3, disabled: [2] },
    ]);
    showNavDigitPreview();
    const options = panel.querySelectorAll('[role="radiogroup"] > button');
    expect(badges().map((b) => b.el)).toEqual([options[0], options[2]]);
    expect(badges().map((b) => b.n)).toEqual(['1', '3']);
  });

  it('numbers nothing in the closed (visibility: hidden) drawer', () => {
    const panes = makePanes(2);
    const { section } = makePinned({
      label: 'Pinned',
      expanded: true,
      rows: 3,
      inHiddenDrawer: true,
    });
    showNavDigitPreview();
    section
      .querySelectorAll('div[role="button"]')
      .forEach((row) =>
        expect(row.hasAttribute('data-web-shell-nav-preview')).toBe(false),
      );
    // The press falls through to the panes, and so do the badges.
    expect(badges().map((b) => b.el)).toEqual(panes);
  });

  it('numbers only the visible split panes', () => {
    const panes = makePanes(3);
    setWidth(panes[1], 0);
    showNavDigitPreview();
    expect(badges().map((b) => b.el)).toEqual([panes[0], panes[2]]);
    expect(badges().map((b) => b.n)).toEqual(['1', '2']);
  });

  it('numbers nothing over the Overview empty-state row', () => {
    makeOverviewRows(0, { emptyRow: true });
    showNavDigitPreview();
    expect(badges()).toEqual([]);
  });

  it('keeps a sticky badge target sticky, anchoring only static ones', () => {
    // The Overview's actions column is `position: sticky` (right-pinned
    // while the table scrolls sideways); the badge must not unpin it.
    // The app's stylesheet loads first; the preview style is injected
    // after it, so a same-specificity rule there would win the tie.
    document.getElementById('webShellNavPreviewStyle')?.remove();
    const sticky = document.createElement('style');
    sticky.textContent = '.sticky { position: sticky; }';
    document.head.appendChild(sticky);
    try {
      const viewport = document.createElement('div');
      viewport.setAttribute('data-web-shell-session-table-viewport', '');
      const table = document.createElement('table');
      const tbody = document.createElement('tbody');
      const cells: HTMLElement[] = [];
      for (let i = 0; i < 2; i++) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        if (i === 0) td.className = 'sticky';
        tr.appendChild(td);
        tbody.appendChild(tr);
        cells.push(td);
      }
      table.appendChild(tbody);
      viewport.appendChild(table);
      setWidth(viewport, 800);
      document.body.appendChild(viewport);
      showNavDigitPreview();
      expect(badges().map((b) => b.el)).toEqual(cells);
      expect(getComputedStyle(cells[0]).position).toBe('sticky');
      expect(cells[0].hasAttribute('data-web-shell-nav-preview-anchor')).toBe(
        false,
      );
      // A static cell gets the anchor for its ::after, and loses it on hide.
      expect(cells[1].hasAttribute('data-web-shell-nav-preview-anchor')).toBe(
        true,
      );
      expect(getComputedStyle(cells[1]).position).toBe('relative');
      hideNavDigitPreview();
      expect(cells[1].hasAttribute('data-web-shell-nav-preview-anchor')).toBe(
        false,
      );
    } finally {
      sticky.remove();
      document.getElementById('webShellNavPreviewStyle')?.remove();
    }
  });

  it('re-numbers a changed list and leaves no orphan badge behind', () => {
    const { section } = makePinned({
      label: 'Pinned',
      expanded: true,
      rows: 2,
    });
    showNavDigitPreview();
    expect(badges().map((b) => b.n)).toEqual(['1', '2']);
    // The list changes under the held modifier (a re-render): one row is
    // removed and a new one joins.
    const rows = section.querySelectorAll('div[role="button"]');
    rows[1].remove();
    const extra = document.createElement('div');
    extra.setAttribute('role', 'button');
    rows[0].parentElement!.appendChild(extra);
    showNavDigitPreview();
    const fresh = section.querySelectorAll('div[role="button"]');
    expect(badges().map((b) => b.el)).toEqual(Array.from(fresh));
    expect(badges().map((b) => b.n)).toEqual(['1', '2']);
  });

  it('hide removes every badge', () => {
    makePinned({ label: 'Pinned', expanded: true, rows: 4 });
    showNavDigitPreview();
    expect(badges()).toHaveLength(4);
    hideNavDigitPreview();
    expect(badges()).toEqual([]);
  });
});
