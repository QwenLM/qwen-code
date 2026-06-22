/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import process from 'node:process';

const debugLogger = createDebugLogger('HISTORY_MANAGER');

// Type for the updater function passed to updateHistoryItem
type HistoryItemUpdater = (
  prevItem: HistoryItem,
) => Partial<HistoryItemWithoutId>;

export const UI_COMPACT_CLEARED_MESSAGE = '[Old tool result content cleared]';
const UI_COMPACT_KEEP_RECENT = 20;

export interface UseHistoryManagerReturn {
  history: HistoryItem[];
  addItem: (itemData: HistoryItemWithoutId, baseTimestamp: number) => number; // Returns the generated ID
  updateItem: (
    id: number,
    updates: Partial<HistoryItemWithoutId> | HistoryItemUpdater,
  ) => void;
  clearItems: () => void;
  loadHistory: (newHistory: HistoryItem[]) => void;
  truncateToItem: (itemId: number) => void;
  compactOldItems: () => void;
}

/**
 * Custom hook to manage the chat history state.
 *
 * Encapsulates the history array, message ID generation, adding items,
 * updating items, and clearing the history.
 */
export function useHistory(): UseHistoryManagerReturn {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const messageIdCounterRef = useRef(0);

  // Generates a unique message ID based on a timestamp and a counter.
  const getNextMessageId = useCallback((baseTimestamp: number): number => {
    messageIdCounterRef.current += 1;
    return baseTimestamp + messageIdCounterRef.current;
  }, []);

  const loadHistory = useCallback((newHistory: HistoryItem[]) => {
    setHistory(newHistory);
  }, []);

  // Adds a new item to the history state with a unique ID.
  const addItem = useCallback(
    (itemData: HistoryItemWithoutId, baseTimestamp: number): number => {
      const id = getNextMessageId(baseTimestamp);
      const newItem: HistoryItem = { ...itemData, id } as HistoryItem;

      setHistory((prevHistory) => {
        if (prevHistory.length > 0) {
          const lastItem = prevHistory[prevHistory.length - 1];
          // Prevent adding duplicate consecutive user messages
          if (
            lastItem.type === 'user' &&
            newItem.type === 'user' &&
            lastItem.text === newItem.text
          ) {
            return prevHistory; // Don't add the duplicate
          }
        }

        const newHistory = [...prevHistory, newItem];
        if (debugLogger.isEnabled()) {
          const textSize = newItem.text?.length ?? 0;
          debugLogger.debug(
            `[ADD_ITEM] type=${newItem.type}, ` +
              `textSize=${textSize}, ` +
              `historyLength=${newHistory.length}`,
          );
        }
        return newHistory;
      });
      return id; // Return the generated ID (even if not added, to keep signature)
    },
    [getNextMessageId],
  );

  /**
   * Updates an existing history item identified by its ID.
   * @deprecated Prefer not to update history item directly as we are currently
   * rendering all history items in <Static /> for performance reasons. Only use
   * if ABSOLUTELY NECESSARY
   */
  //
  const updateItem = useCallback(
    (
      id: number,
      updates: Partial<HistoryItemWithoutId> | HistoryItemUpdater,
    ) => {
      setHistory((prevHistory) => {
        let updated = false;
        const nextHistory = prevHistory.map((item) => {
          if (item.id === id) {
            updated = true;
            // Apply updates based on whether it's an object or a function
            const newUpdates =
              typeof updates === 'function' ? updates(item) : updates;
            return { ...item, ...newUpdates } as HistoryItem;
          }
          return item;
        });
        if (!updated) {
          debugLogger.debug(
            `Skipped history update; item ${id} was not found.`,
          );
          return prevHistory;
        }
        return nextHistory;
      });
    },
    [],
  );

  // Clears the entire history state and resets the ID counter.
  const clearItems = useCallback(() => {
    if (debugLogger.isEnabled()) {
      debugLogger.debug(
        `[CLEAR_HISTORY] Clearing history, memory before=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`,
      );
    }
    setHistory([]);
    messageIdCounterRef.current = 0;
  }, []);

  // Truncates history to exclude the item with the given ID and everything after it.
  const truncateToItem = useCallback((itemId: number) => {
    setHistory((prev) => {
      const index = prev.findIndex((h) => h.id === itemId);
      return index === -1 ? prev : prev.slice(0, index);
    });
  }, []);

  const compactOldItems = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;

      let thoughtRemoved = 0;
      let toolGroupsCompacted = 0;

      let totalThoughts = 0;
      let totalToolGroupsWithOutput = 0;
      for (const item of prev) {
        if (
          item.type === 'gemini_thought' ||
          item.type === 'gemini_thought_content'
        ) {
          totalThoughts++;
        } else if (
          item.type === 'tool_group' &&
          item.tools.some(
            (t) =>
              t.resultDisplay != null &&
              t.resultDisplay !== UI_COMPACT_CLEARED_MESSAGE,
          )
        ) {
          totalToolGroupsWithOutput++;
        }
      }
      const thoughtsToDrop = Math.max(
        0,
        totalThoughts - UI_COMPACT_KEEP_RECENT,
      );
      const toolGroupsToCompact = Math.max(
        0,
        totalToolGroupsWithOutput - UI_COMPACT_KEEP_RECENT,
      );
      let thoughtsDropped = 0;
      let toolGroupsSeen = 0;

      const next = prev
        .filter((item) => {
          if (
            item.type === 'gemini_thought' ||
            item.type === 'gemini_thought_content'
          ) {
            if (thoughtsDropped < thoughtsToDrop) {
              thoughtsDropped++;
              thoughtRemoved++;
              return false;
            }
          }
          return true;
        })
        .map((item) => {
          if (item.type !== 'tool_group') return item;
          // Check for any non-null resultDisplay (covers string, FileDiff,
          // AnsiOutputDisplay, AgentResultDisplay, etc.)
          const hasOldOutput = item.tools.some(
            (t) =>
              t.resultDisplay != null &&
              t.resultDisplay !== UI_COMPACT_CLEARED_MESSAGE,
          );
          if (!hasOldOutput) return item;
          toolGroupsSeen++;
          if (toolGroupsSeen > toolGroupsToCompact) return item;
          toolGroupsCompacted++;
          return {
            ...item,
            tools: item.tools.map((t) => {
              if (
                t.resultDisplay != null &&
                t.resultDisplay !== UI_COMPACT_CLEARED_MESSAGE
              ) {
                return { ...t, resultDisplay: UI_COMPACT_CLEARED_MESSAGE };
              }
              return t;
            }),
          };
        });

      if (thoughtRemoved > 0 || toolGroupsCompacted > 0) {
        if (debugLogger.isEnabled()) {
          debugLogger.debug(
            `[COMPACT_UI_HISTORY] removed ${thoughtRemoved} thought item(s), ` +
              `compacted ${toolGroupsCompacted} tool group(s), ` +
              `historyLength ${prev.length} -> ${next.length}, ` +
              `memory=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`,
          );
        }
      }
      return thoughtRemoved > 0 || toolGroupsCompacted > 0 ? next : prev;
    });
  }, []);

  return useMemo(
    () => ({
      history,
      addItem,
      updateItem,
      clearItems,
      loadHistory,
      truncateToItem,
      compactOldItems,
    }),
    [
      history,
      addItem,
      updateItem,
      clearItems,
      loadHistory,
      truncateToItem,
      compactOldItems,
    ],
  );
}
