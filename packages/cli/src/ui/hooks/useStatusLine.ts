/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { exec } from 'child_process';
import { useSettings } from '../contexts/SettingsContext.js';
import { isShellCommandReadOnlyAST } from '@qwen-code/qwen-code-core';

export function useStatusLine(): string | null {
  const settings = useSettings();
  const statusLineCommand = settings.merged.ui?.statusLine;
  const [output, setOutput] = useState<string | null>(null);

  useEffect(() => {
    if (!statusLineCommand) {
      setOutput(null);
      return;
    }

    let isMounted = true;

    const executeCommand = async () => {
      try {
        const isReadOnly = await isShellCommandReadOnlyAST(statusLineCommand);
        if (!isReadOnly) {
          if (isMounted) setOutput('⚠️ Sandbox: Command must be read-only');
          return;
        }

        exec(
          statusLineCommand,
          { timeout: 5000, maxBuffer: 1024 * 10 },
          (error, stdout) => {
            if (!isMounted) return;
            if (!error && stdout) {
              setOutput(stdout.trim().split('\n')[0] || null);
            } else {
              setOutput(null);
            }
          },
        );
      } catch {
        if (isMounted) setOutput('⚠️ Sandbox: Verification failed');
      }
    };

    // Execute immediately
    executeCommand();

    // Poll every 5 seconds
    const interval = setInterval(executeCommand, 5000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [statusLineCommand]);

  return output;
}
