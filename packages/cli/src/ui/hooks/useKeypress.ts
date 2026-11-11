/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions derived from vybestack/llxprt-code (Apache-2.0),
 * Copyright 2025 Vybestack LLC. See NOTICE for attribution details.
 */

import { useEffect } from 'react';
import {
  useKeypressContext,
  type KeypressHandler,
  type Key,
} from '../contexts/KeypressContext.js';

export type { Key };

/**
 * A hook that listens for keypress events from stdin.
 *
 * @param onKeypress - The callback function to execute on each keypress.
 * @param options - Options to control the hook's behavior.
 * @param options.isActive - Whether the hook should be actively listening for input.
 */
export function useKeypress(
  onKeypress: KeypressHandler,
  { isActive }: { isActive: boolean },
) {
  const { subscribe, unsubscribe } = useKeypressContext();

  useEffect(() => {
    if (!isActive) {
      return;
    }

    subscribe(onKeypress);
    return () => {
      unsubscribe(onKeypress);
    };
  }, [isActive, onKeypress, subscribe, unsubscribe]);
}
