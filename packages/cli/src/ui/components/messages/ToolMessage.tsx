/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box } from 'ink';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ShellInputPrompt } from '../ShellInputPrompt.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import {
  ToolStatusIndicator,
  ToolInfo,
  TrailingIndicator,
  isThisShellFocusable,
  isThisShellFocused,
  useFocusHint,
  FocusHint,
  STATUS_INDICATOR_WIDTH,
  type TextEmphasis,
} from './ToolShared.js';
import type { Config } from '@qwen-code/qwen-code-core';

const STATIC_HEIGHT = 1;
const RESERVED_LINE_COUNT = 5;
const MIN_LINES_SHOWN = 2;

export interface ToolMessageProps extends IndividualToolCallDisplay {
  availableTerminalHeight?: number;
  contentWidth: number;
  emphasis?: TextEmphasis;
  renderOutputAsMarkdown?: boolean;
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  config?: Config;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  availableTerminalHeight,
  contentWidth,
  emphasis = 'medium',
  renderOutputAsMarkdown = true,
  activeShellPtyId,
  embeddedShellFocused,
  ptyId,
  config,
}) => {
  const isThisShellFocusedResult = isThisShellFocused(
    name,
    status,
    ptyId,
    activeShellPtyId,
    embeddedShellFocused,
  );

  const isThisShellFocusableResult = isThisShellFocusable(name, status, config);

  const { shouldShowFocusHint } = useFocusHint(
    isThisShellFocusableResult,
    isThisShellFocusedResult,
    resultDisplay,
  );

  const availableHeight = availableTerminalHeight
    ? Math.max(
        availableTerminalHeight - STATIC_HEIGHT - RESERVED_LINE_COUNT,
        MIN_LINES_SHOWN + 1,
      )
    : undefined;

  const innerWidth = contentWidth - STATUS_INDICATOR_WIDTH;

  let outputRenderAsMarkdown = renderOutputAsMarkdown;
  if (availableHeight) {
    outputRenderAsMarkdown = false;
  }

  return (
    <Box paddingX={1} paddingY={0} flexDirection="column">
      <Box minHeight={1}>
        <ToolStatusIndicator status={status} name={name} />
        <ToolInfo
          name={name}
          status={status}
          description={description}
          emphasis={emphasis}
        />
        <FocusHint
          shouldShowFocusHint={shouldShowFocusHint}
          isThisShellFocused={isThisShellFocusedResult}
        />
        {emphasis === 'high' && <TrailingIndicator />}
      </Box>
      {resultDisplay && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH} width="100%" marginTop={1}>
          <Box flexDirection="column">
            <ToolResultDisplay
              resultDisplay={resultDisplay}
              availableTerminalHeight={availableHeight}
              terminalWidth={innerWidth}
              renderOutputAsMarkdown={outputRenderAsMarkdown}
              hasFocus={isThisShellFocusedResult}
              config={config}
            />
          </Box>
        </Box>
      )}
      {isThisShellFocusedResult && config && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH} marginTop={1}>
          <ShellInputPrompt
            activeShellPtyId={activeShellPtyId ?? null}
            focus={embeddedShellFocused}
          />
        </Box>
      )}
    </Box>
  );
};
