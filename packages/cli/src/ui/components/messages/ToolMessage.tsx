/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import {
  ToolStatusIndicator,
  ToolInfo,
  TrailingIndicator,
  McpProgressIndicator,
  type TextEmphasis,
} from './ToolShared.js';
import { type Config, CoreToolCallStatus, Kind } from '@qwen-code/core';
import { SUBAGENT_MAX_LINES } from '../../constants.js';
import { ToolContainer } from './ToolContainer.js';

export type { TextEmphasis };

export interface ToolMessageProps extends IndividualToolCallDisplay {
  availableTerminalHeight?: number;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  renderOutputAsMarkdown?: boolean;
  isFirst: boolean;
  borderColor: string;
  borderDimColor: boolean;
  activeShellId?: number | null;
  executionId?: number;
  config?: Config;
  /** Maximum lines of output to show (truncation). Undefined = no limit. */
  maxOutputLines?: number;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  kind,
  availableTerminalHeight,
  terminalWidth,
  emphasis = 'medium',
  renderOutputAsMarkdown = true,
  isFirst,
  borderColor,
  borderDimColor,
  activeShellId: _activeShellId,
  executionId: _executionId,
  config: _config,
  progressMessage,
  originalRequestName,
  progress,
  progressTotal,
  maxOutputLines,
}) => {
  const showProgress =
    status === CoreToolCallStatus.Executing && progress !== undefined;
  const showResult = resultDisplay !== undefined && resultDisplay !== '';

  const header = (
    <>
      <ToolStatusIndicator status={status} />
      <ToolInfo
        name={name}
        status={status}
        description={description}
        emphasis={emphasis}
        progressMessage={progressMessage}
        originalRequestName={originalRequestName}
      />
      {emphasis === 'high' && <TrailingIndicator />}
    </>
  );

  return (
    // It is crucial we don't replace this <> with a Box because otherwise the
    // sticky header inside it would be sticky to that box rather than to the
    // parent component of this ToolMessage.
    <ToolContainer
      header={header}
      terminalWidth={terminalWidth}
      sticky
      stickyProps={{ isFirst, borderColor, borderDimColor }}
    >
      {showProgress || showResult ? (
        <>
          {showProgress && (
            <McpProgressIndicator
              progress={progress}
              total={progressTotal}
              message={progressMessage}
              barWidth={20}
            />
          )}
          {showResult && (
            <ToolResultDisplay
              resultDisplay={resultDisplay}
              availableTerminalHeight={availableTerminalHeight}
              terminalWidth={terminalWidth}
              renderOutputAsMarkdown={renderOutputAsMarkdown}
              hasFocus={false}
              maxLines={
                maxOutputLines !== undefined
                  ? maxOutputLines
                  : kind === Kind.Agent && availableTerminalHeight !== undefined
                    ? SUBAGENT_MAX_LINES
                    : undefined
              }
              overflowDirection={kind === Kind.Agent ? 'bottom' : 'top'}
            />
          )}
        </>
      ) : null}
    </ToolContainer>
  );
};
