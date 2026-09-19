/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';
import type { KeypressHandler, Key } from '../contexts/KeypressContext.js';
import { useKeypressContext } from '../contexts/KeypressContext.js';

export type { Key };

/**
 * A hook that listens for keypress events from stdin.
 *
 * @param onKeypress - The callback function to execute on each keypress.
 * @param options - Options to control the hook's behavior.
 * @param options.isActive - Whether the hook should be actively listening for input.
 * @param options.exclusive - While subscribed, ordinary (non-exclusive)
 *   handlers do not receive keys; returning `false` from the handler releases
 *   a declined key back to them. Reserved for modal surfaces that own the
 *   keyboard while mounted (the right-click context menu overlay).
 */
export function useKeypress(
  onKeypress: KeypressHandler,
  { isActive, exclusive = false }: { isActive: boolean; exclusive?: boolean },
) {
  const { subscribe, unsubscribe } = useKeypressContext();
  const onKeypressRef = useRef(onKeypress);

  onKeypressRef.current = onKeypress;

  // Forward the inner return value: an exclusive handler's `false` (key
  // declined) must reach KeypressContext's broadcast, not die here.
  const handleKeypress = useCallback<KeypressHandler>(
    (key) => onKeypressRef.current(key),
    [],
  );

  useEffect(() => {
    if (!isActive) {
      return;
    }

    subscribe(handleKeypress, { exclusive });
    return () => {
      unsubscribe(handleKeypress);
    };
  }, [isActive, exclusive, handleKeypress, subscribe, unsubscribe]);
}
