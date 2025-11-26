/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import type { Storage } from '@qwen-code/qwen-code-core';
import { Logger } from '@qwen-code/qwen-code-core';

/**
 * Hook to manage the logger instance.
 */
export const useLogger = (storage: Storage, sessionId: string) => {
  const [logger, setLogger] = useState<Logger | null>(null);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const newLogger = new Logger(sessionId, storage);
    /**
     * Start async initialization, no need to await. Using await slows down the
     * time from launch to see the gemini-cli prompt and it's better to not save
     * messages than for the cli to hanging waiting for the logger to loading.
     */
    newLogger
      .initialize()
      .then(() => {
        setLogger(newLogger);
      })
      .catch(() => {});
  }, [storage, sessionId]);

  return logger;
};
