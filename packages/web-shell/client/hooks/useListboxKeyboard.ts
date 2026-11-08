import { useContext, useEffect, useRef, useState } from 'react';
import {
  DialogShellIdContext,
  isTopDialogShellId,
} from '../components/dialogs/DialogShell';

export interface ListboxKeyboardOptions {
  /** Number of selectable items in the list. */
  itemCount: number;
  /** Currently highlighted index, or -1 when no row is highlighted. */
  activeIndex: number;
  /** Called with the next index when the user moves the highlight. */
  onActiveIndexChange: (index: number) => void;
  /** Called with an index when the user confirms it (Enter). */
  onConfirm: (index: number) => void;
  /** Disable the listener without unmounting the host component. */
  enabled?: boolean;
}

export interface ListboxKeyboardResult {
  /**
   * True while the user is navigating by keyboard. Dialogs use this to suppress
   * the CSS `:hover` highlight so a cursor that happens to rest over a row —
   * e.g. when the dialog opens under the pointer — does not fight the keyboard
   * highlight. It flips back to false on a real `mousemove` (which never fires
   * from a dialog merely appearing under a stationary cursor).
   */
  keyboardMode: boolean;
}

function clamp(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  if (index < 0) return 0;
  if (index > itemCount - 1) return itemCount - 1;
  return index;
}

const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset']);

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
]);

/**
 * True when the focused element natively acts on Enter (a dialog button, link,
 * textarea, etc.). In that case list confirmation must yield so, e.g., Enter on
 * a focused "Delete" button triggers the button rather than toggling a row.
 * Text inputs are intentionally NOT listed here: in the searchable dialogs
 * focus never leaves the filter input, so Enter from it must still confirm —
 * but only a row the user visibly highlighted first (see the `active < 0`
 * guard in the Enter case).
 */
function focusOwnsEnter(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    return BUTTON_INPUT_TYPES.has((el as HTMLInputElement).type);
  }
  const role = el.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'menuitem';
}

/**
 * True when focus is in an editable text field, where Home/End must keep their
 * native caret behaviour (jump to start/end of the text) instead of being
 * hijacked to move the list highlight.
 */
function focusOwnsHomeEnd(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    return !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Keyboard navigation for listbox-style dialogs (model/theme/approval/resume/…).
 *
 * Selection is driven by `activeIndex` state rather than DOM focus, so it works
 * whether focus sits on the dialog panel/listbox or on a search input. The
 * visual highlight + `scrollIntoView` already implemented by each dialog
 * reflects the active index; this hook only moves that index and confirms it.
 *
 * Enter confirms the active row, unless focus is on a control that owns Enter
 * (see {@link focusOwnsEnter}) — so, e.g., Enter on a focused "Delete" button
 * activates the button — or no row is highlighted (`activeIndex < 0`).
 * Searchable dialogs rely on the latter: they open with no highlight and reset
 * to none whenever the filter text changes, so a reflexive Enter in the search
 * box never confirms a row the user didn't visibly pick first; the first
 * ArrowDown lands on the first row. Space mirrors Enter (per the ARIA listbox
 * pattern) but additionally yields to text fields, where it types a space.
 * Escape is intentionally NOT handled here — {@link DialogShell} owns dialog
 * dismissal.
 */
export function useListboxKeyboard({
  itemCount,
  activeIndex,
  onActiveIndexChange,
  onConfirm,
  enabled = true,
}: ListboxKeyboardOptions): ListboxKeyboardResult {
  const dialogShellId = useContext(DialogShellIdContext);
  // Keep latest values in a ref so the listener is bound once, not per keystroke.
  const stateRef = useRef({
    itemCount,
    activeIndex,
    onActiveIndexChange,
    onConfirm,
  });
  stateRef.current = { itemCount, activeIndex, onActiveIndexChange, onConfirm };

  const [keyboardMode, setKeyboardMode] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    const enterKeyboardMode = () => setKeyboardMode(true);
    const exitKeyboardMode = () => setKeyboardMode(false);

    const handleKeyDown = (event: KeyboardEvent) => {
      // Only the active/topmost dialog should react. In stacked dialogs, a
      // background listbox must ignore Arrow/Enter/Space even though it also
      // has a global listener. The shell id comes from DialogShell context, so
      // focus may sit on either the search input or the list itself.
      if (!isTopDialogShellId(dialogShellId)) return;
      // keyCode 229 is the cross-browser "this key belongs to the IME" marker.
      // WebKit fires `compositionend` BEFORE the committing Enter's keydown,
      // so that keydown arrives with isComposing === false — only the legacy
      // keyCode identifies it as an IME commit rather than a real Enter.
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
        return;
      // Only plain keypresses drive list navigation. Modified combos are OS/text
      // shortcuts (e.g. Cmd+↑/↓ = text start/end on macOS, Shift+↑/↓ = extend
      // selection) and must reach the focused input untouched.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const { itemCount: count, activeIndex: active } = stateRef.current;
      if (count <= 0) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          enterKeyboardMode();
          stateRef.current.onActiveIndexChange(clamp(active + 1, count));
          break;
        case 'ArrowUp':
          event.preventDefault();
          enterKeyboardMode();
          stateRef.current.onActiveIndexChange(clamp(active - 1, count));
          break;
        case 'Home':
          // Let an editable field keep Home for caret-to-start.
          if (focusOwnsHomeEnd()) return;
          event.preventDefault();
          enterKeyboardMode();
          stateRef.current.onActiveIndexChange(0);
          break;
        case 'End':
          if (focusOwnsHomeEnd()) return;
          event.preventDefault();
          enterKeyboardMode();
          stateRef.current.onActiveIndexChange(count - 1);
          break;
        case 'Enter': {
          // Let a focused button/link/etc. handle its own Enter activation.
          if (focusOwnsEnter()) return;
          // No highlighted row → nothing to confirm. Searchable dialogs open
          // with activeIndex -1 and reset to -1 on filter edits, so Enter in
          // the search box only ever acts on a row the user visibly chose.
          if (active < 0) return;
          event.preventDefault();
          stateRef.current.onConfirm(clamp(active, count));
          break;
        }
        case ' ': {
          // The ARIA listbox pattern selects on Space as well as Enter (the
          // option rows used to be native <button>s, which gave this for
          // free). Space types a space in a text field and activates a
          // focused button natively, so only treat it as "select" when the
          // list truly owns the key. preventDefault also stops the browser's
          // default page-scroll when focus sits on the scrollable list.
          if (focusOwnsEnter() || focusOwnsHomeEnd()) return;
          if (active < 0) return;
          event.preventDefault();
          stateRef.current.onConfirm(clamp(active, count));
          break;
        }
        default:
          break;
      }
    };

    // `window` bubble phase — the last stop in the propagation chain. This
    // ordering is a contract with DialogShell: its `document`-level listener
    // runs first and stops propagation on Escape/Tab, so those keys never
    // arrive here (and the defaultPrevented check above covers anything a
    // dialog control consumed). We additionally scope handling to the active
    // dialog via DialogShell context so stacked list dialogs can't drive the
    // background one. Don't move this to `document` or capture.
    window.addEventListener('keydown', handleKeyDown);
    // `mousemove` (not `mouseenter`) marks the switch back to pointer control:
    // it only fires on genuine cursor movement, so a dialog opening under a
    // stationary pointer never yanks control away from the keyboard.
    window.addEventListener('mousemove', exitKeyboardMode);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousemove', exitKeyboardMode);
    };
  }, [dialogShellId, enabled]);

  return { keyboardMode };
}
