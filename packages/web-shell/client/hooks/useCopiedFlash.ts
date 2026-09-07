/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The transient "copied" feedback every copy button shows: `flash()` turns
 * the flag on and schedules the reset. The pending reset is cleared on
 * unmount — a leaked timer fires after a test file's environment is torn
 * down and, since the unit suites fail on unhandled errors, turns an
 * all-green run red (`window is not defined` out of the reset callback).
 * A re-flash restarts the window instead of letting the older reset cut
 * the newer feedback short.
 */
export function useCopiedFlash(
  resetMs = 2000,
): [copied: boolean, flash: () => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const flash = useCallback(() => {
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), resetMs);
  }, [resetMs]);
  return [copied, flash];
}
