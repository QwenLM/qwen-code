/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, useIsScreenReaderEnabled } from 'ink';
import { theme } from '../../semantic-colors.js';
import {
  getSafeLowColorFrameBase,
  interpolateColor,
  resolveColor,
} from '../../themes/color-utils.js';
import { isLowColorDepth } from '../../utils/terminalUtils.js';
import { getBorderStyle } from '../../utils/borderStyles.js';

const INPUT_FRAME_TEXT_BLEND = 0.5;

export type InputFrameWidth = React.ComponentProps<typeof Box>['width'];
type InputFrameBorderText = React.ComponentProps<typeof Box>['borderText'];

export interface InputFrameProps {
  children: React.ReactNode;
  active?: boolean;
  width?: InputFrameWidth;
  /** Optional label embedded at the right end of the top border. */
  title?: string;
}

/**
 * Resolve the canonical input-frame color without coupling it to prompt status
 * or permission mode. The semantic input border keeps compatibility with the
 * previous theme input color while the component itself remains transparent.
 */
export function resolveInputFrameColor(
  terminalBg: string,
  isLowColor: boolean,
): string {
  const baseColor = isLowColor
    ? getSafeLowColorFrameBase(terminalBg) || theme.border.default
    : resolveColor(theme.border.input) || theme.border.input;
  const textColor = resolveColor(theme.text.primary) || theme.text.primary;

  if (baseColor.startsWith('#') && textColor.startsWith('#')) {
    return (
      interpolateColor(baseColor, textColor, INPUT_FRAME_TEXT_BLEND) ||
      baseColor
    );
  }

  return baseColor;
}

/**
 * The single visual surface for standalone text inputs. It intentionally does
 * not expose background or per-callsite border overrides.
 */
export function InputFrame({
  children,
  active = true,
  width = '100%',
  title,
}: InputFrameProps): React.JSX.Element {
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const terminalBg = theme.background.primary || 'black';
  const borderColor = active
    ? resolveInputFrameColor(terminalBg, isLowColorDepth())
    : theme.border.default;
  // The label uses the accent color so it reads as a name rather than as part
  // of the line; the renderer still dims it with the border when inactive.
  // Read outside the memo so a theme switch refreshes the label color.
  const labelColor = theme.text.accent;
  // Memoised: Ink compares style values shallowly, so a fresh object on every
  // render would mark the prompt box dirty on each keystroke.
  const borderText = useMemo<InputFrameBorderText>(
    () =>
      title
        ? {
            content: title,
            position: 'top',
            align: 'end',
            padding: 1,
            color: labelColor,
          }
        : undefined,
    [title, labelColor],
  );

  return (
    <Box
      flexDirection="row"
      alignItems="flex-start"
      borderStyle={isScreenReaderEnabled ? undefined : getBorderStyle('input')}
      borderLeft={false}
      borderRight={false}
      borderTop={!isScreenReaderEnabled}
      borderBottom={!isScreenReaderEnabled}
      borderColor={borderColor || undefined}
      // Dim while unfocused so focus is legible at a glance, not just by hue.
      borderDimColor={!active}
      borderText={borderText}
      width={width}
      paddingX={1}
    >
      {children}
    </Box>
  );
}
