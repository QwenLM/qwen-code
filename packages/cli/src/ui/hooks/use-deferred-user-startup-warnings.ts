/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { DeferredUserStartupWarnings } from '../../utils/userStartupWarnings.js';

export function useDeferredUserStartupWarnings(
  config: Config,
  pending?: DeferredUserStartupWarnings,
): readonly string[] {
  const cwd = process.cwd();
  const selection = useMemo(
    () => ({ config, pending, cwd }),
    [config, pending, cwd],
  );
  const current = useRef(selection);
  current.current = selection;
  const [loaded, setLoaded] = useState<{
    selection: typeof selection;
    warnings: readonly string[];
  }>();

  useEffect(() => {
    if (
      !pending ||
      pending.config !== config ||
      pending.workspaceRoot !== cwd ||
      pending.signal.aborted
    ) {
      return;
    }
    let active = true;
    const isCurrent = () =>
      active &&
      current.current === selection &&
      process.cwd() === cwd &&
      !pending.signal.aborted;
    const abort = () => {
      if (active && current.current === selection) {
        setLoaded(undefined);
      }
    };
    pending.signal.addEventListener('abort', abort);
    void pending.promise.then(
      (warnings) => {
        if (isCurrent()) {
          setLoaded({ selection, warnings: [...new Set(warnings)] });
        }
      },
      (error: unknown) => {
        if (isCurrent()) {
          setLoaded({
            selection,
            warnings: [
              `Could not check startup warnings: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ],
          });
        }
      },
    );
    return () => {
      active = false;
      pending.signal.removeEventListener('abort', abort);
    };
  }, [config, pending, cwd, selection]);

  return loaded?.selection === selection &&
    pending?.config === config &&
    pending.workspaceRoot === cwd &&
    !pending.signal.aborted
    ? loaded.warnings
    : [];
}
