/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

export interface InlineSessionRenameOptions {
  /** The label the title shows now; it prefills the editor on open. */
  label: string;
  /**
   * Identity of the session the title names. Undefined leaves the title
   * inert; a change closes an open editor and drops its draft.
   */
  sessionKey: string | undefined;
  /**
   * Persists the new name. The caller owns error reporting: a rejection is
   * only swallowed here so the editor can settle.
   */
  onSave: ((displayName: string) => Promise<unknown>) | undefined;
}

export interface InlineSessionRenameTitleProps {
  ref: (element: HTMLElement | null) => void;
  role: 'button';
  tabIndex: 0;
  'data-web-shell-pane-title': '';
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface InlineSessionRenameInputProps {
  ref: (element: HTMLInputElement | null) => void;
  value: string;
  readOnly: boolean;
  'aria-busy': boolean | undefined;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFocus: (event: FocusEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export interface InlineSessionRename {
  editing: boolean;
  /** Spread onto the title element; undefined when rename is unavailable. */
  titleProps: InlineSessionRenameTitleProps | undefined;
  inputProps: InlineSessionRenameInputProps;
}

/**
 * Single-click inline rename of a session title, shared by the pane title and
 * the chat header: a click (or Enter/Space on the focused title) swaps the
 * title for an input prefilled with the label; Enter saves, Escape or blur
 * cancels, and an empty or unchanged name closes without a write. The title
 * click is not stopped on its way to document: open Radix surfaces rely on
 * the native click for deferred outside-press dismissal.
 */
export function useInlineSessionRename({
  label,
  sessionKey,
  onSave,
}: InlineSessionRenameOptions): InlineSessionRename {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // Synchronous mirrors: a second keydown can arrive before React re-renders.
  const editingRef = useRef(false);
  const savingRef = useRef(false);
  // The label as it was when the editor opened. "Unchanged" means unchanged
  // from what the user saw: the live label can move under an open editor
  // (the real name arriving for a placeholder title), and comparing against
  // it would turn a dismiss-Enter into a write of the stale prefill.
  const initialRef = useRef('');
  // Bumped on every open and on a session swap; a settling write touches
  // the editor only while the generation it started in is still current.
  const generationRef = useRef(0);
  const titleRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef(false);

  const close = useCallback((restoreFocus: boolean) => {
    editingRef.current = false;
    restoreFocusRef.current = restoreFocus;
    setEditing(false);
    setDraft('');
  }, []);

  useEffect(() => {
    // A session swap must not keep a stale draft (it would be written to
    // the newly shown session) nor let the old session's write settle into
    // an editor opened for the new one.
    generationRef.current += 1;
    savingRef.current = false;
    setSaving(false);
    close(false);
  }, [sessionKey, close]);

  useEffect(() => {
    // Hand focus back to the title after a keyboard-driven save or Escape,
    // so the user keeps their place; blur and session swaps leave focus
    // wherever it went.
    if (editing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    titleRef.current?.focus();
  }, [editing]);

  const available = Boolean(sessionKey && onSave && label);

  const open = useCallback(() => {
    if (!available || editingRef.current || savingRef.current) return;
    generationRef.current += 1;
    initialRef.current = label;
    editingRef.current = true;
    setDraft(label);
    setEditing(true);
  }, [available, label]);

  const save = useCallback(() => {
    // A second Enter while a write is in flight is ignored, not treated as
    // an empty submit: the input is read-only meanwhile, so there is no
    // newer draft to lose.
    if (savingRef.current) return;
    const nextName = draft.trim();
    if (!nextName || nextName === initialRef.current || !onSave) {
      close(true);
      return;
    }
    const generation = generationRef.current;
    savingRef.current = true;
    setSaving(true);
    void onSave(nextName)
      .catch(() => undefined)
      .finally(() => {
        if (generationRef.current !== generation) return;
        savingRef.current = false;
        setSaving(false);
        if (editingRef.current) {
          close(document.activeElement === inputRef.current);
        }
      });
  }, [close, draft, onSave]);

  const setTitleElement = useCallback((element: HTMLElement | null) => {
    titleRef.current = element;
  }, []);
  const setInputElement = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element;
  }, []);

  const titleProps: InlineSessionRenameTitleProps | undefined = available
    ? {
        ref: setTitleElement,
        role: 'button',
        tabIndex: 0,
        'data-web-shell-pane-title': '',
        onClick: (event) => {
          // A drag that ends on the title leaves a live text selection; a
          // real pointer click (detail > 0) finishing one stays out of
          // rename. Keyboard activation never reaches this guard.
          if (event.detail > 0 && window.getSelection()?.isCollapsed === false)
            return;
          open();
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open();
        },
      }
    : undefined;

  const inputProps: InlineSessionRenameInputProps = {
    ref: setInputElement,
    value: draft,
    readOnly: saving,
    'aria-busy': saving || undefined,
    onChange: (event) => setDraft(event.target.value),
    onFocus: (event) => event.currentTarget.select(),
    onBlur: () => {
      if (editingRef.current) close(false);
    },
    onKeyDown: (event) => {
      // The editor owns its keys: pane-level Escape (maximize) and approval
      // shortcuts must not see them.
      event.stopPropagation();
      // keyCode 229 marks an IME key: WebKit fires compositionend before the
      // committing Enter's keydown, so isComposing alone misses it.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        save();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    },
  };

  return { editing, titleProps, inputProps };
}
