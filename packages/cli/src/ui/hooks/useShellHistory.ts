/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createDebugLogger,
  isNodeError,
  Storage,
} from '@qwen-code/qwen-code-core';

const MAX_HISTORY_LENGTH = 100;
const debugLogger = createDebugLogger('SHELL_HISTORY');

export interface UseShellHistoryReturn {
  history: string[];
  addCommandToHistory: (command: string) => void;
  getPreviousCommand: () => string | null;
  getNextCommand: () => string | null;
  resetHistoryPosition: () => void;
}

async function getHistoryFilePath(
  projectRoot: string,
  configStorage?: Storage,
): Promise<string> {
  const storage = configStorage ?? new Storage(projectRoot);
  return storage.getHistoryFilePath();
}

// Handle multiline commands
async function readHistoryFile(filePath: string): Promise<string[]> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    const parsed = parseHistoryFile(text);
    if (parsed) return parsed;

    return parseLegacyHistoryFile(text);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    debugLogger.error('Error reading history:', err);
    return [];
  }
}

function parseHistoryFile(text: string): string[] | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((entry): entry is string => typeof entry === 'string')
    ) {
      return parsed;
    }
  } catch {
    // Fall back to the original line-based history format.
  }
  return undefined;
}

function parseLegacyHistoryFile(text: string): string[] {
  const result: string[] = [];
  let cur = '';

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const line = raw;

    const m = cur.match(/(\\+)$/);
    if (m && m[1].length % 2) {
      // odd number of trailing '\'
      cur = cur.slice(0, -1) + ' ' + line;
    } else {
      if (cur) result.push(cur);
      cur = line;
    }
  }

  if (cur) result.push(cur);
  return result;
}

async function writeHistoryFile(
  filePath: string,
  history: string[],
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(history));
  } catch (error) {
    debugLogger.error('Error writing shell history:', error);
  }
}

export function useShellHistory(
  projectRoot: string,
  storage?: Storage,
): UseShellHistoryReturn {
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyRef = useRef<string[]>([]);
  const historyFilePath = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    historyRef.current = [];
    historyFilePath.current = null;
    setHistory([]);
    setHistoryIndex(-1);

    async function loadHistory() {
      const filePath = await getHistoryFilePath(projectRoot, storage);
      if (cancelled) return;
      const loadedHistory = await readHistoryFile(filePath);
      if (!cancelled) {
        const pendingHistory = historyRef.current;
        const savedHistory = loadedHistory.reverse(); // Newest first
        const mergedHistory = pendingHistory.length
          ? [
              ...pendingHistory,
              ...savedHistory.filter(
                (command) => !pendingHistory.includes(command),
              ),
            ]
              .slice(0, MAX_HISTORY_LENGTH)
              .filter(Boolean)
          : savedHistory;
        historyRef.current = mergedHistory;
        historyFilePath.current = filePath;
        setHistory(mergedHistory);
        if (pendingHistory.length) {
          writeHistoryFile(filePath, [...mergedHistory].reverse());
        }
      }
    }
    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [projectRoot, storage]);

  const addCommandToHistory = useCallback((command: string) => {
    if (!command.trim()) {
      return;
    }
    const newHistory = [
      command,
      ...historyRef.current.filter((c) => c !== command),
    ]
      .slice(0, MAX_HISTORY_LENGTH)
      .filter(Boolean);
    historyRef.current = newHistory;
    setHistory(newHistory);
    if (historyFilePath.current) {
      // Write to file in reverse order (oldest first)
      writeHistoryFile(historyFilePath.current, [...newHistory].reverse());
    }
    setHistoryIndex(-1);
  }, []);

  const getPreviousCommand = useCallback(() => {
    if (history.length === 0) {
      return null;
    }
    const newIndex = Math.min(historyIndex + 1, history.length - 1);
    setHistoryIndex(newIndex);
    return history[newIndex] ?? null;
  }, [history, historyIndex]);

  const getNextCommand = useCallback(() => {
    if (historyIndex < 0) {
      return null;
    }
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    if (newIndex < 0) {
      return '';
    }
    return history[newIndex] ?? null;
  }, [history, historyIndex]);

  const resetHistoryPosition = useCallback(() => {
    setHistoryIndex(-1);
  }, []);

  return {
    history,
    addCommandToHistory,
    getPreviousCommand,
    getNextCommand,
    resetHistoryPosition,
  };
}
