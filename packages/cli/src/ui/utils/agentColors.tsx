/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import type { AgentColor } from '@qwen-code/core';
import { theme } from '../semantic-colors.js';

/**
 * Resolves an agent color name to the theme-adapted background color string.
 * Returns undefined if the color is not set.
 */
export function resolveAgentColor(
  color: AgentColor | undefined,
): string | undefined {
  if (!color) return undefined;
  return theme.agent[color];
}

/**
 * Renders an agent name as a colored badge when a background color is
 * provided, or as bold text with an optional foreground color otherwise.
 */
export const AgentNameBadge: React.FC<{
  name: string;
  bgColor?: string;
  textColor?: string;
  wrap?: 'truncate' | 'wrap' | 'end';
}> = ({ name, bgColor, textColor, wrap }) =>
  bgColor ? (
    <Text
      bold
      backgroundColor={bgColor}
      color={theme.agent.badgeText}
      wrap={wrap}
    >
      {` ${name} `}
    </Text>
  ) : (
    <Text bold color={textColor ?? theme.text.primary} wrap={wrap}>
      {name}
    </Text>
  );
