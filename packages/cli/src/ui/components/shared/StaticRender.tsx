/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo } from 'react';
import type React from 'react';
import { Box } from 'ink';

interface StaticRenderProps {
  children: React.ReactElement;
  width?: number | string;
}

/**
 * Wraps a child in a fixed-width `<Box>` so completed history items in the
 * virtualized list have a stable layout box. The actual "freeze" of unchanged
 * items is delivered by `memo(HistoryItemDisplay)` one level deeper (the
 * `VirtualHistoryItem` wrapper in `MainContent`): a stable history item
 * reference makes React reconcile that subtree to a no-op.
 *
 * Note: this is NOT output caching like gemini-cli's `@jrichman/ink`
 * `StaticRender` export. The reference-equality comparator below is a
 * cheap belt-and-braces check; the parent's `renderedItems` `useMemo`
 * normally allocates fresh JSX on every recompute, so the comparator
 * rarely matches for in-viewport items. The real bail-out happens deeper.
 */
const StaticRender = memo(
  ({ children, width }: StaticRenderProps) => (
    <Box width={width} flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  ),
  (prev, next) => prev.children === next.children && prev.width === next.width,
);

StaticRender.displayName = 'StaticRender';

export { StaticRender };
