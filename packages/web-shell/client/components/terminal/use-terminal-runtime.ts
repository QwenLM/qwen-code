/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

type TerminalRuntime = typeof import('./terminal-runtime');

export function useTerminalRuntime(enabled = true) {
  const [runtime, setRuntime] = useState<TerminalRuntime | 'failed'>();
  useEffect(() => {
    if (!enabled || runtime) return;
    let cancelled = false;
    void import('./terminal-runtime').then(
      (loaded) => {
        if (!cancelled) setRuntime(loaded);
      },
      () => {
        if (!cancelled) setRuntime('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, runtime]);
  return enabled ? runtime : undefined;
}
