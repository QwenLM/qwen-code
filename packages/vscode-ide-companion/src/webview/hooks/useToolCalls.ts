/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { ToolCallData } from '../components/ToolCall.js';
import type { ToolCallUpdate } from '../types/toolCall.js';

/**
 * Tool call management Hook
 * Manages tool call states and updates
 */
export const useToolCalls = () => {
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCallData>>(
    new Map(),
  );

  /**
   * Handle tool call update
   */
  const handleToolCallUpdate = useCallback((update: ToolCallUpdate) => {
    setToolCalls((prevToolCalls) => {
      const newMap = new Map(prevToolCalls);
      const existing = newMap.get(update.toolCallId);

      // Helpers for todo/todos plan merging & content replacement
      const isTodoWrite = (kind?: string) =>
        (kind || '').toLowerCase() === 'todo_write' ||
        (kind || '').toLowerCase() === 'todowrite' ||
        (kind || '').toLowerCase() === 'update_todos';

      const normTitle = (t: unknown) =>
        typeof t === 'string' ? t.trim().toLowerCase() : '';

      const isTodoTitleMergeable = (t?: unknown) => {
        const nt = normTitle(t);
        return nt === 'updated plan' || nt === 'update todos';
      };

      const extractText = (
        content?: Array<{
          type: 'content' | 'diff';
          content?: { text?: string };
        }>,
      ): string => {
        if (!content || content.length === 0) {
          return '';
        }
        const parts: string[] = [];
        for (const item of content) {
          if (item.type === 'content' && item.content?.text) {
            parts.push(String(item.content.text));
          }
        }
        return parts.join('\n');
      };

      const normalizeTodoLines = (text: string): string[] => {
        if (!text) {
          return [];
        }
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        return lines.map((line) => {
          const idx = line.indexOf('] ');
          return idx >= 0 ? line.slice(idx + 2).trim() : line;
        });
      };

      const isSameOrSupplement = (
        prevText: string,
        nextText: string,
      ): { same: boolean; supplement: boolean } => {
        const prev = normalizeTodoLines(prevText);
        const next = normalizeTodoLines(nextText);
        if (prev.length === next.length) {
          const same = prev.every((l, i) => l === next[i]);
          if (same) {
            return { same: true, supplement: false };
          }
        }
        // supplement = prev set is subset of next set
        const setNext = new Set(next);
        const subset = prev.every((l) => setNext.has(l));
        return { same: false, supplement: subset };
      };

      const safeTitle = (title: unknown): string => {
        if (typeof title === 'string') {
          return title;
        }
        if (title && typeof title === 'object') {
          return JSON.stringify(title);
        }
        return 'Tool Call';
      };

      if (update.type === 'tool_call') {
        const content = update.content?.map((item) => ({
          type: item.type as 'content' | 'diff',
          content: item.content,
          path: item.path,
          oldText: item.oldText,
          newText: item.newText,
        }));

        // Merge strategy: For todo_write + mergeable titles (Updated Plan/Update Todos),
        // if it is the same as or a supplement to the most recent similar card, merge the update instead of adding new.
        if (isTodoWrite(update.kind) && isTodoTitleMergeable(update.title)) {
          const nextText = extractText(content);
          // Find the most recent card with todo_write + mergeable title
          let lastId: string | null = null;
          let lastText = '';
          let lastTimestamp = 0;
          for (const tc of newMap.values()) {
            if (
              isTodoWrite(tc.kind) &&
              isTodoTitleMergeable(tc.title) &&
              typeof tc.timestamp === 'number' &&
              tc.timestamp >= lastTimestamp
            ) {
              lastId = tc.toolCallId;
              lastText = extractText(tc.content);
              lastTimestamp = tc.timestamp || 0;
            }
          }

          if (lastId) {
            const cmp = isSameOrSupplement(lastText, nextText);
            if (cmp.same) {
              // Completely identical: Ignore this addition
              return newMap;
            }
            if (cmp.supplement) {
              // Supplement: Replace content to the previous item (using update semantics)
              const prev = newMap.get(lastId);
              if (prev) {
                newMap.set(lastId, {
                  ...prev,
                  content, // Override (do not append)
                  status: update.status || prev.status,
                  timestamp: update.timestamp || Date.now(),
                });
                return newMap;
              }
            }
          }
        }

        newMap.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          kind: update.kind || 'other',
          title: safeTitle(update.title),
          status: update.status || 'pending',
          rawInput: update.rawInput as string | object | undefined,
          content,
          locations: update.locations,
          timestamp: update.timestamp || Date.now(), // Add timestamp
        });
      } else if (update.type === 'tool_call_update') {
        const updatedContent = update.content
          ? update.content.map((item) => ({
              type: item.type as 'content' | 'diff',
              content: item.content,
              path: item.path,
              oldText: item.oldText,
              newText: item.newText,
            }))
          : undefined;

        if (existing) {
          // Default behavior is to append; but for todo_write + mergeable titles, use replacement to avoid stacking duplicates
          let mergedContent = existing.content;
          if (updatedContent) {
            if (
              isTodoWrite(update.kind || existing.kind) &&
              (isTodoTitleMergeable(update.title) ||
                isTodoTitleMergeable(existing.title))
            ) {
              mergedContent = updatedContent; // Override
            } else {
              mergedContent = [...(existing.content || []), ...updatedContent];
            }
          }
          // If tool call has just completed/failed, bump timestamp to now for correct ordering
          const isFinal =
            update.status === 'completed' || update.status === 'failed';
          const nextTimestamp = isFinal
            ? Date.now()
            : update.timestamp || existing.timestamp || Date.now();

          newMap.set(update.toolCallId, {
            ...existing,
            ...(update.kind && { kind: update.kind }),
            ...(update.title && { title: safeTitle(update.title) }),
            ...(update.status && { status: update.status }),
            content: mergedContent,
            ...(update.locations && { locations: update.locations }),
            timestamp: nextTimestamp, // Update timestamp (use completion time when completed/failed)
          });
        } else {
          newMap.set(update.toolCallId, {
            toolCallId: update.toolCallId,
            kind: update.kind || 'other',
            title: update.title ? safeTitle(update.title) : '',
            status: update.status || 'pending',
            rawInput: update.rawInput as string | object | undefined,
            content: updatedContent,
            locations: update.locations,
            timestamp: update.timestamp || Date.now(), // Add timestamp
          });
        }
      }

      return newMap;
    });
  }, []);

  /**
   * Clear all tool calls
   */
  const clearToolCalls = useCallback(() => {
    setToolCalls(new Map());
  }, []);

  /**
   * Get in-progress tool calls
   */
  const inProgressToolCalls = Array.from(toolCalls.values()).filter(
    (toolCall) =>
      toolCall.status === 'pending' || toolCall.status === 'in_progress',
  );

  /**
   * Get completed tool calls
   */
  const completedToolCalls = Array.from(toolCalls.values()).filter(
    (toolCall) =>
      toolCall.status === 'completed' || toolCall.status === 'failed',
  );

  return {
    toolCalls,
    inProgressToolCalls,
    completedToolCalls,
    handleToolCallUpdate,
    clearToolCalls,
  };
};
