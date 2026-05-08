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
 * Renders children once and caches the result. Subsequent renders with the
 * same key+width return the cached render without re-walking through React.
 * Used by VirtualizedList to freeze completed conversation items.
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
