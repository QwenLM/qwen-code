/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text } from 'ink';
import { applyMarkdown } from './markdownTokenizer.js';
import { stripUnsafeCharacters } from './textUtils.js';

interface RenderInlineProps {
  text: string;
  defaultColor?: string;
  codespanColor?: string;
}

const RenderInlineInternal: React.FC<RenderInlineProps> = ({
  text: rawText,
  defaultColor,
  codespanColor,
}) => {
  const text = stripUnsafeCharacters(rawText);
  // Apply defaultColor via the React Text prop instead of chalk-encoding it
  // into the string. Ink's wrap path (trim:false, hard:true) only emits the
  // opening color code on the first wrapped line, so chalk-applied colors are
  // dropped on continuation lines. The Text color prop is reapplied by Ink to
  // every wrapped line, which preserves the color across line breaks.
  const ansiText = applyMarkdown(text, undefined, codespanColor);

  return <Text color={defaultColor}>{ansiText}</Text>;
};

export const RenderInline = React.memo(RenderInlineInternal);
