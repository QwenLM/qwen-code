/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useContext,
  useEffect,
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
  ComponentType<ThinkingBodyProps> | undefined
>(undefined);

/** The body an expanded thought shows. */
export function ThinkingBody(props: ThinkingBodyProps) {
  const Component = useContext(ThinkingBodyComponentContext);
  const { onRewrittenChange } = props;
  useEffect(() => {
    if (!Component) onRewrittenChange?.(undefined);
  }, [Component, onRewrittenChange]);
  if (Component) return <Component {...props} />;
  return (
    <Markdown
      content={props.content}
      source="thinking"
      isStreaming={props.isStreaming}
    />
  );
}
