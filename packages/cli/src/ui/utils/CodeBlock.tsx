/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box } from 'ink';
import { colorizeCode } from './CodeColorizer.js';
import { useSettings } from '../contexts/SettingsContext.js';

export const CODE_BLOCK_PREFIX_PADDING = 1;

interface RenderCodeBlockProps {
  content: string;
  lang: string | null;
  terminalWidth: number;
  shrinkToContent?: boolean;
}

const RenderCodeBlockInternal: React.FC<RenderCodeBlockProps> = ({
  content,
  lang,
  terminalWidth,
  shrinkToContent = false,
}) => {
  const settings = useSettings();

  const codeOptions = {
    code: content,
    language: lang,
    maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
    settings,
    hideLineNumbers: true,
  };
  const colorizedCode = shrinkToContent
    ? colorizeCode({ ...codeOptions, returnLines: true })
    : colorizeCode(codeOptions);

  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={shrinkToContent ? undefined : terminalWidth}
      maxWidth={terminalWidth}
      flexShrink={0}
    >
      {colorizedCode}
    </Box>
  );
};

export const RenderCodeBlock = React.memo(RenderCodeBlockInternal);
