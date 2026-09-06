import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
} from 'react';

export interface FilterInputProps {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void;
}

export interface UseFilterInputResult {
  /**
   * Committed value to filter by. Only changes once a keystroke is committed,
   * never while an IME composition is in flight, so filtering a list by this
   * value does not refilter/relayout on every intermediate pinyin character.
   */
  filterValue: string;
  /** Spread onto the search `<input>` (carries the raw value + IME handlers). */
  inputProps: FilterInputProps;
}

/**
 * Search-field state for filterable list dialogs, hardened against IME
 * composition jitter: the field reflects every keystroke while the committed
 * `filterValue` (used to filter) updates only on non-composition input and on
 * `compositionend`.
 *
 * `onFilterChange` fires with the committed value whenever it changes — dialogs
 * use it to reset their own selection/cursor state.
 */
export function useFilterInput(
  onFilterChange?: (value: string) => void,
): UseFilterInputResult {
  const [inputValue, setInputValue] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const composingRef = useRef(false);
  const committedRef = useRef('');
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;

  const commit = useCallback((value: string) => {
    // `compositionend` fires even when the composition was cancelled and the
    // text is back to what it was. A no-op commit must not signal a filter
    // change — dialogs reset their selection/cursor state on that signal, so
    // a cancelled composition would wipe e.g. the delete dialog's checkmarks.
    if (value === committedRef.current) return;
    committedRef.current = value;
    setFilterValue(value);
    onFilterChangeRef.current?.(value);
  }, []);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setInputValue(value);
      // Skip filtering while an IME composition is in flight; compositionend
      // commits the final value.
      if (!composingRef.current) commit(value);
    },
    [commit],
  );

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLInputElement>) => {
      composingRef.current = false;
      const value = event.currentTarget.value;
      // Most browsers follow compositionend with an `input` event that syncs
      // the controlled value, but that's not guaranteed — sync it here too so
      // the field can never display a stale preedit while the list already
      // filters by the committed text.
      setInputValue(value);
      commit(value);
    },
    [commit],
  );

  return {
    filterValue,
    inputProps: {
      value: inputValue,
      onChange,
      onCompositionStart,
      onCompositionEnd,
    },
  };
}
