import { useEffect, useRef, useState } from 'react';

export interface ListboxKeyboardOptions {
  /** Number of selectable items in the list. */
  itemCount: number;
  /** Currently highlighted index. */
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

/**
 * True when the focused element natively acts on Enter (a dialog button, link,
 * textarea, etc.). In that case list confirmation must yield so, e.g., Enter on
 * a focused "Delete" button triggers the button rather than toggling a row.
 */
function focusOwnsEnter(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA') return true;
  const role = el.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'menuitem';
}

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
 * activates the button. Escape is intentionally NOT handled here —
 * {@link DialogShell} owns dialog dismissal.
 */
export function useListboxKeyboard({
  itemCount,
  activeIndex,
  onActiveIndexChange,
  onConfirm,
  enabled = true,
}: ListboxKeyboardOptions): ListboxKeyboardResult {
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
      if (event.defaultPrevented || event.isComposing) return;
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
          event.preventDefault();
          stateRef.current.onConfirm(clamp(active, count));
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    // `mousemove` (not `mouseenter`) marks the switch back to pointer control:
    // it only fires on genuine cursor movement, so a dialog opening under a
    // stationary pointer never yanks control away from the keyboard.
    window.addEventListener('mousemove', exitKeyboardMode);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousemove', exitKeyboardMode);
    };
  }, [enabled]);

  return { keyboardMode };
}
