/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Markdown } from './Markdown';
import type { ThinkingBodyProps } from './ThinkingBody';

export function useThinkingBodyRewrite() {
  return [false, undefined] as const;
}

export function ThinkingBody({ content, isStreaming }: ThinkingBodyProps) {
  return (
    <Markdown content={content} source="thinking" isStreaming={isStreaming} />
  );
}
