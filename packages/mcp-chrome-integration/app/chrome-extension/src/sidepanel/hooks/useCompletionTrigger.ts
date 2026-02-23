/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RefObject } from 'react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { CompletionItem } from '../../types/completionItemTypes.js';

interface CompletionTriggerState {
  isOpen: boolean;
  triggerChar: '@' | '/' | null;
  query: string;
  position: { top: number; left: number };
  items: CompletionItem[];
}

/**
 * Hook to handle @ and / completion triggers in contentEditable
 * Based on vscode-copilot-chat's AttachContextAction
 */
export function useCompletionTrigger(
  inputRef: RefObject<HTMLDivElement>,
  getCompletionItems: (
    trigger: '@' | '/',
    query: string,
  ) => Promise<CompletionItem[]>,
) {
  // Show immediate loading and provide a timeout fallback for slow sources
  const LOADING_ITEM = useMemo<CompletionItem>(
    () => ({
      id: 'loading',
      label: 'Loading…',
      type: 'info',
    }),
    [],
  );

  const TIMEOUT_ITEM = useMemo<CompletionItem>(
    () => ({
      id: 'timeout',
      label: 'Timeout',
      type: 'info',
    }),
    [],
  );
  const TIMEOUT_MS = 5000;

  const [state, setState] = useState<CompletionTriggerState>({
    isOpen: false,
    triggerChar: null,
    query: '',
    position: { top: 0, left: 0 },
    items: [],
  });

  // Timer for loading timeout
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeCompletion = useCallback(() => {
    // Clear pending timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setState({
      isOpen: false,
      triggerChar: null,
      query: '',
      position: { top: 0, left: 0 },
      items: [],
    });
  }, []);

  const openCompletion = useCallback(
    async (
      trigger: '@' | '/',
      query: string,
      position: { top: number; left: number },
    ) => {
      // Clear previous timeout if any
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Open immediately with a loading placeholder
      setState({
        isOpen: true,
        triggerChar: trigger,
        query,
        position,
        items: [LOADING_ITEM],
      });

      // Schedule a timeout fallback if loading takes too long
      timeoutRef.current = setTimeout(() => {
        setState((prev) => {
          // Only show timeout if still open and still for the same request
          if (
            prev.isOpen &&
            prev.triggerChar === trigger &&
            prev.query === query &&
            prev.items.length > 0 &&
            prev.items[0]?.id === 'loading'
          ) {
            return { ...prev, items: [TIMEOUT_ITEM] };
          }
          return prev;
        });
      }, TIMEOUT_MS);

      const items = await getCompletionItems(trigger, query);

      // Clear timeout on success
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      setState((prev) => ({
        ...prev,
        isOpen: true,
        triggerChar: trigger,
        query,
        position,
        items,
      }));
    },
    [getCompletionItems, LOADING_ITEM, TIMEOUT_ITEM],
  );

  // Helper function to compare completion items arrays
  const areItemsEqual = (
    items1: CompletionItem[],
    items2: CompletionItem[],
  ): boolean => {
    if (items1.length !== items2.length) {
      return false;
    }

    // Compare each item by stable fields (ignore non-deterministic props like icons)
    for (let i = 0; i < items1.length; i++) {
      const a = items1[i];
      const b = items2[i];
      if (a.id !== b.id) {
        return false;
      }
      if (a.label !== b.label) {
        return false;
      }
      if ((a.description ?? '') !== (b.description ?? '')) {
        return false;
      }
      if (a.type !== b.type) {
        return false;
      }
      if ((a.value ?? '') !== (b.value ?? '')) {
        return false;
      }
      if ((a.path ?? '') !== (b.path ?? '')) {
        return false;
      }
    }

    return true;
  };

  const refreshCompletion = useCallback(async () => {
    if (!state.isOpen || !state.triggerChar) {
      return;
    }
    const items = await getCompletionItems(state.triggerChar, state.query);

    // Only update state if items have actually changed
    setState((prev) => {
      if (areItemsEqual(prev.items, items)) {
        return prev;
      }
      return { ...prev, items };
    });
  }, [state.isOpen, state.triggerChar, state.query, getCompletionItems]);

  useEffect(() => {
    const inputElement = inputRef.current;
    if (!inputElement) {
      return;
    }

    const getCursorPosition = (): { top: number; left: number } | null => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return null;
      }

      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        // If the range has a valid position, use it
        if (rect.top > 0 && rect.left > 0) {
          return {
            top: rect.top,
            left: rect.left,
          };
        }

        // Fallback: use input element's position
        const inputRect = inputElement.getBoundingClientRect();
        return {
          top: inputRect.top,
          left: inputRect.left,
        };
      } catch (error) {
        console.error(
          '[useCompletionTrigger] Error getting cursor position:',
          error,
        );
        const inputRect = inputElement.getBoundingClientRect();
        return {
          top: inputRect.top,
          left: inputRect.left,
        };
      }
    };

    const handleInput = async () => {
      const text = inputElement.textContent || '';
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        console.log('[useCompletionTrigger] No selection or rangeCount === 0');
        return;
      }

      const range = selection.getRangeAt(0);

      // Get cursor position more reliably
      // For contentEditable, we need to calculate the actual text offset
      let cursorPosition = text.length; // Default to end of text

      if (range.startContainer === inputElement) {
        // Cursor is directly in the container (e.g., empty or at boundary)
        // Use childNodes to determine position
        const childIndex = range.startOffset;
        let offset = 0;
        for (
          let i = 0;
          i < childIndex && i < inputElement.childNodes.length;
          i++
        ) {
          offset += inputElement.childNodes[i].textContent?.length || 0;
        }
        cursorPosition = offset || text.length;
      } else if (range.startContainer.nodeType === Node.TEXT_NODE) {
        // Cursor is in a text node - calculate offset from start of input
        const walker = document.createTreeWalker(
          inputElement,
          NodeFilter.SHOW_TEXT,
          null,
        );

        let offset = 0;
        let found = false;
        let node: Node | null = walker.nextNode();
        while (node) {
          if (node === range.startContainer) {
            offset += range.startOffset;
            found = true;
            break;
          }
          offset += node.textContent?.length || 0;
          node = walker.nextNode();
        }
        // If we found the node, use the calculated offset; otherwise use text length
        cursorPosition = found ? offset : text.length;
      }

      // Find trigger character before cursor
      // Use text length if cursorPosition is 0 but we have text (edge case for first character)
      const effectiveCursorPosition =
        cursorPosition === 0 && text.length > 0 ? text.length : cursorPosition;

      const textBeforeCursor = text.substring(0, effectiveCursorPosition);
      const lastAtMatch = textBeforeCursor.lastIndexOf('@');
      const lastSlashMatch = textBeforeCursor.lastIndexOf('/');

      // Check if we're in a trigger context
      let triggerPos = -1;
      let triggerChar: '@' | '/' | null = null;

      if (lastAtMatch > lastSlashMatch) {
        triggerPos = lastAtMatch;
        triggerChar = '@';
      } else if (lastSlashMatch > lastAtMatch) {
        triggerPos = lastSlashMatch;
        triggerChar = '/';
      }

      // Check if trigger is at word boundary (start of line or after space)
      if (triggerPos >= 0 && triggerChar) {
        const charBefore = triggerPos > 0 ? text[triggerPos - 1] : ' ';
        const isValidTrigger =
          charBefore === ' ' || charBefore === '\n' || triggerPos === 0;

        if (isValidTrigger) {
          const query = text.substring(triggerPos + 1, effectiveCursorPosition);

          // Only show if query doesn't contain spaces (still typing the reference)
          if (!query.includes(' ') && !query.includes('\n')) {
            // Get precise cursor position for menu
            const cursorPos = getCursorPosition();
            if (cursorPos) {
              await openCompletion(triggerChar, query, cursorPos);
              return;
            }
          }
        }
      }

      // Close if no valid trigger
      if (state.isOpen) {
        closeCompletion();
      }
    };

    inputElement.addEventListener('input', handleInput);
    return () => inputElement.removeEventListener('input', handleInput);
  }, [inputRef, state.isOpen, openCompletion, closeCompletion]);

  return {
    isOpen: state.isOpen,
    triggerChar: state.triggerChar,
    query: state.query,
    position: state.position,
    items: state.items,
    closeCompletion,
    openCompletion,
    refreshCompletion,
  };
}
