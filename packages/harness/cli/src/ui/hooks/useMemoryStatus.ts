/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { relative } from 'node:path';
import {
  type Config,
  type MemoryChangedPayload,
  CoreEvent,
  coreEvents,
  MAX_MEMORY_CHARACTER_COUNT,
  type StartupWarning,
  WarningPriority,
} from '@qwen-code/core';

export interface UseMemoryStatusReturn {
  memoryMdFileCount: number;
  memoryWarnings: StartupWarning[];
}

/**
 * Tracks AGENTS.md / memory file count + per-file warnings emitted via
 * CoreEvent.MemoryChanged. Owns its own state so AppContainer doesn't have
 * to thread MemoryChanged listeners alongside its other responsibilities.
 */
export function useMemoryStatus(config: Config): UseMemoryStatusReturn {
  const [memoryMdFileCount, setMemoryMdFileCount] = useState<number>(
    config.getMemoryMdFileCount(),
  );
  const [memoryWarnings, setMemoryWarnings] = useState<StartupWarning[]>([]);

  useEffect(() => {
    const cwd = process.cwd();
    const handleMemoryChanged = (result: MemoryChangedPayload) => {
      setMemoryMdFileCount(result.fileCount);
      const warnings: StartupWarning[] = [];

      if (result.largeFiles && result.largeFiles.length > 0) {
        for (const file of result.largeFiles) {
          const displayPath = file.path.startsWith(cwd)
            ? relative(cwd, file.path)
            : file.path;
          warnings.push({
            id: `large-memory-${file.path}`,
            message: `Large ${displayPath} will impact performance (${file.characterCount.toLocaleString()} chars > ${MAX_MEMORY_CHARACTER_COUNT.toLocaleString()})`,
            priority: WarningPriority.High,
          });
        }
      }

      if (result.failedFiles && result.failedFiles.length > 0) {
        for (const file of result.failedFiles) {
          const displayPath = file.path.startsWith(cwd)
            ? relative(cwd, file.path)
            : file.path;
          warnings.push({
            id: `failed-memory-${file.path}`,
            message: `Failed to load ${displayPath}: ${file.error}`,
            priority: WarningPriority.High,
          });
        }
      }

      setMemoryWarnings(warnings);
    };
    coreEvents.on(CoreEvent.MemoryChanged, handleMemoryChanged);
    return () => {
      coreEvents.off(CoreEvent.MemoryChanged, handleMemoryChanged);
    };
  }, []);

  return { memoryMdFileCount, memoryWarnings };
}
