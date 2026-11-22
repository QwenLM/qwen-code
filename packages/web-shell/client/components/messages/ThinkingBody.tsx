/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ComponentType,
} from 'react';
import { Markdown } from './Markdown';

export interface ThinkingBodyProps {
  content: string;
  isStreaming?: boolean;
  /** A subagent's thought, drawn outside its tool card. */
  fromSubagent?: boolean;
  /** Reports the source text of the displayed rewrite, if any. */
  onRewrittenChange?: (source: string | undefined) => void;
}

export const ThinkingBodyComponentContext = createContext<
  { Body: ComponentType<ThinkingBodyProps> } | undefined
>(undefined);

export function useThinkingBodyRewrite(content: string) {
  const renderer = useContext(ThinkingBodyComponentContext);
  const [rewrite, setRewrite] = useState<{
    renderer: NonNullable<typeof renderer>;
    source: string;
  }>();
  const onRewrittenChange = useCallback(
    (source: string | undefined) => {
      setRewrite(
        renderer && source !== undefined ? { renderer, source } : undefined,
      );
    },
    [renderer],
  );
  const rewritten =
    rewrite?.renderer === renderer && rewrite?.source === content;
  return [rewritten, onRewrittenChange] as const;
}

/** The body an expanded thought shows. */
export function ThinkingBody(props: ThinkingBodyProps) {
  const renderer = useContext(ThinkingBodyComponentContext);
  if (renderer) return <renderer.Body {...props} />;
  return (
    <Markdown
      content={props.content}
      source="thinking"
      isStreaming={props.isStreaming}
    />
  );
}
