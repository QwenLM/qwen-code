/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as fs from 'node:fs/promises';
import {
  createDebugLogger,
  isNodeError,
  Storage,
} from '@qwen-code/qwen-code-core';
import {
  appendShellHistoryFile,
  parseShellHistoryText,
  SHELL_HISTORY_MAX_ENTRIES,
} from '../../utils/shell-history-file.js';
import { registerCleanup } from '../../utils/cleanup.js';

const pendingShellHistoryWrites = new Set<Promise<void>>();
let unregisterExitDrain: (() => void) | undefined;

function trackShellHistoryWrite(write: Promise<void>): void {
  if (pendingShellHistoryWrites.size === 0) {
    unregisterExitDrain = registerCleanup(async () => {
      // Include writes that arrive while the exit drain is already active.
      while (pendingShellHistoryWrites.size > 0) {
        await Promise.all([...pendingShellHistoryWrites]);
      }
    });
  }
  pendingShellHistoryWrites.add(write);
}

const MAX_HISTORY_LENGTH = SHELL_HISTORY_MAX_ENTRIES;
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
    return parseShellHistoryText(text);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    debugLogger.error('Error reading history:', err);
    return [];
  }
}

async function writeHistoryFile(filePath: string, command: string) {
  try {
    await appendShellHistoryFile(filePath, command);
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
  const [historyFilePath, setHistoryFilePath] = useState<string | null>(null);
  const writeQueuesRef = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      const filePath = await getHistoryFilePath(projectRoot, storage);
      if (cancelled) return;
      setHistoryFilePath(filePath);
      const loadedHistory = await readHistoryFile(filePath);
      if (!cancelled) {
        setHistory(loadedHistory.reverse()); // Newest first
      }
    }
    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [projectRoot, storage]);

  const addCommandToHistory = useCallback(
    (command: string) => {
      if (!command.trim() || !historyFilePath) {
        return;
      }
      const newHistory = [command, ...history.filter((c) => c !== command)]
        .slice(0, MAX_HISTORY_LENGTH)
        .filter(Boolean);
      setHistory(newHistory);
      const queues = writeQueuesRef.current;
      const previous = queues.get(historyFilePath) ?? Promise.resolve();
      const write = () => writeHistoryFile(historyFilePath, command);
      const next = previous.then(write, write);
      queues.set(historyFilePath, next);
      trackShellHistoryWrite(next);
      const cleanup = () => {
        if (queues.get(historyFilePath) === next) {
          queues.delete(historyFilePath);
        }
        pendingShellHistoryWrites.delete(next);
        if (pendingShellHistoryWrites.size === 0) {
          unregisterExitDrain?.();
          unregisterExitDrain = undefined;
        }
      };
      void next.then(cleanup, cleanup);
      setHistoryIndex(-1);
    },
    [history, historyFilePath],
  );

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
