/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useRef } from 'react';
import { Box } from 'ink';
import { useTerminalViewport } from '../../ink/hooks/use-terminal-viewport.js';
import { useAlternateBuffer } from '../hooks/useAlternateBuffer.js';

type Props = {
  children: React.ReactNode;
  /**
   * Terminal width that drove this subtree's layout. A frozen snapshot is
   * measured at one width; when the width changes the cached geometry is stale,
   * so a new value forces a re-snapshot even while the row is offscreen.
   */
  layoutKey: number;
};

/**
 * Keeps the last visible React element mounted after a complete history row
 * moves into native terminal scrollback. Returning the same element reference
 * lets React skip that subtree until the row becomes visible again.
 */
export function OffscreenFreeze({ children, layoutKey }: Props): React.ReactNode {
  'use no memo';

  const bypassFreeze = useAlternateBuffer();
  const [ref, entry, , measureNow] = useTerminalViewport();
  const cachedChildren = useRef(children);
  const cachedLayoutKey = useRef(layoutKey);
  const isVisible = measureNow() ?? entry.isVisible;
  const layoutChanged = !Object.is(cachedLayoutKey.current, layoutKey);

  if (isVisible || bypassFreeze || layoutChanged) {
    cachedChildren.current = children;
    cachedLayoutKey.current = layoutKey;
  }

  return <Box ref={ref}>{cachedChildren.current}</Box>;
}
