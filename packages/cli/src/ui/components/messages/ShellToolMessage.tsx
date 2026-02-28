/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, type DOMElement } from 'ink';
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
  type TextEmphasis,
  STATUS_INDICATOR_WIDTH,
} from './ToolShared.js';
import type { Config } from '@qwen-code/qwen-code-core';

export interface ShellToolMessageProps {
  name: string;
  description: string;
  resultDisplay: unknown;
  status: string;
  availableTerminalHeight?: number;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  renderOutputAsMarkdown?: boolean;
  ptyId?: number;
  config?: Config;
  isFirst?: boolean;
  borderColor?: string;
  borderDimColor?: boolean;
}

export const ShellToolMessage: React.FC<ShellToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  availableTerminalHeight,
  terminalWidth,
  emphasis = 'medium',
  renderOutputAsMarkdown = true,
  ptyId,
  config,
  isFirst = false,
  borderColor,
  borderDimColor,
}) => {
  const activeShellPtyId = ptyId ?? null;
  const embeddedShellFocused = false;

  const isThisShellFocusedResult = isThisShellFocused(
    name,
    status as never,
    ptyId,
    activeShellPtyId,
    embeddedShellFocused,
  );

  const isThisShellFocusableResult = isThisShellFocusable(
    name,
    status as never,
    config,
  );

  const { shouldShowFocusHint } = useFocusHint(
    isThisShellFocusableResult,
    isThisShellFocusedResult,
    resultDisplay,
  );

  const headerRef = React.useRef<DOMElement>(null);
  const contentRef = React.useRef<DOMElement>(null);

  const combinedPaddingAndBorderWidth = 4;
  const innerWidth = terminalWidth - combinedPaddingAndBorderWidth;

  return (
    <>
      <Box
        ref={headerRef}
        borderStyle="round"
        width={terminalWidth}
        borderColor={borderColor}
        borderDimColor={borderDimColor}
        borderBottom={false}
        borderTop={isFirst}
        borderLeft={true}
        borderRight={true}
        paddingX={1}
        paddingBottom={1}
        paddingTop={isFirst ? 0 : 1}
      >
        <ToolStatusIndicator status={status as never} name={name} />
        <ToolInfo
          name={name}
          description={description}
          status={status as never}
          emphasis={emphasis}
        />
        <FocusHint
          shouldShowFocusHint={shouldShowFocusHint}
          isThisShellFocused={isThisShellFocusedResult}
        />
        {emphasis === 'high' && <TrailingIndicator />}
      </Box>

      <Box
        ref={contentRef}
        width={terminalWidth}
        borderStyle="round"
        borderColor={borderColor}
        borderDimColor={borderDimColor}
        borderTop={false}
        borderBottom={false}
        borderLeft={true}
        borderRight={true}
        paddingX={1}
        flexDirection="column"
      >
        <ToolResultDisplay
          resultDisplay={resultDisplay}
          availableTerminalHeight={availableTerminalHeight}
          terminalWidth={innerWidth}
          renderOutputAsMarkdown={renderOutputAsMarkdown}
          hasFocus={isThisShellFocusedResult}
          config={config}
        />
        {isThisShellFocusedResult && config && (
          <Box paddingLeft={STATUS_INDICATOR_WIDTH} marginTop={1}>
            <ShellInputPrompt
              activeShellPtyId={activeShellPtyId}
              focus={embeddedShellFocused}
            />
          </Box>
        )}
      </Box>
    </>
  );
};
