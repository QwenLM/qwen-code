/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage, runLogger } from '@qwen-code/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lockSync } from 'proper-lockfile';

const STATE_FILENAME = 'state.json';

interface PersistentStateData {
  terminalSetupPromptShown?: boolean;
  shiftEnterKeyBindingInstalled?: boolean;
  optionAsMetaKeyInstalled?: boolean;
  tipsShown?: number;
  /** Times /btw was asked with a question; hides the /btw spinner tip once non-zero. */
  btwUseCount?: number;
  /** Set once the user has stashed a prompt or been shown the ctrl+s hint. */
  promptStashHintShown?: boolean;
  focusUiEnabled?: boolean;
  startupWarningCounts?: Record<string, number>;
  // Add other persistent state keys here as needed
}

interface PersistentStateUpdate<T, R> {
  value: T;
  result: R;
}

export class PersistentState {
  private cache: PersistentStateData | null = null;
  private filePath: string | null = null;

  private getPath(): string {
    if (!this.filePath) {
      this.filePath = path.join(Storage.getGlobalConfigDir(), STATE_FILENAME);
    }
    return this.filePath;
  }

  private readFromDisk(): PersistentStateData {
    try {
      const filePath = this.getPath();
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as PersistentStateData)
          : {};
      }
    } catch (error) {
      runLogger.warn('Failed to load persistent state:', error);
    }
    return {};
  }

  private load(): PersistentStateData {
    if (!this.cache) {
      this.cache = this.readFromDisk();
    }
    return this.cache;
  }

  get<K extends keyof PersistentStateData>(
    key: K,
  ): PersistentStateData[K] | undefined {
    return this.load()[key];
  }

  set<K extends keyof PersistentStateData>(
    key: K,
    value: PersistentStateData[K],
  ): void {
    this.update(key, (current) =>
      current === value ? undefined : { value, result: true },
    );
  }

  /**
   * Atomically update one key against the latest state written by any CLI
   * process. The callback and disk write run under the same cross-process lock.
   * Lock contention and I/O failures are best-effort: no mutation is applied
   * and `undefined` is returned.
   */
  update<K extends keyof PersistentStateData, R>(
    key: K,
    updater: (
      current: PersistentStateData[K] | undefined,
    ) => PersistentStateUpdate<PersistentStateData[K], R> | undefined,
  ): R | undefined {
    const filePath = this.getPath();
    const dir = path.dirname(filePath);
    let release: (() => void) | undefined;

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      release = lockSync(filePath, {
        realpath: false,
        retries: 0,
        stale: 10_000,
      });
    } catch (error) {
      runLogger.warn('Failed to lock persistent state:', error);
      return undefined;
    }

    try {
      const latest = this.readFromDisk();
      const update = updater(latest[key]);
      if (!update) {
        this.cache = latest;
        return undefined;
      }

      const next = { ...latest, [key]: update.value };
      fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
      this.cache = next;
      return update.result;
    } catch (error) {
      runLogger.warn('Failed to update persistent state:', error);
      return undefined;
    } finally {
      try {
        release();
      } catch (error) {
        runLogger.warn('Failed to unlock persistent state:', error);
      }
    }
  }
}

export const persistentState = new PersistentState();
