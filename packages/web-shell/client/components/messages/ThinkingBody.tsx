/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, type ComponentType } from 'react';
import { Markdown } from './Markdown';

export interface ThinkingBodyProps {
  content: string;
  isStreaming?: boolean;
  /** A subagent's thought, drawn outside its tool card. */
  fromSubagent?: boolean;
  /** Called once the body draws a Mod's rewrite of the thought. */
  onRewritten?: () => void;
}

export const ThinkingBodyComponentContext = createContext<
  ComponentType<ThinkingBodyProps> | undefined
>(undefined);

/** The body an expanded thought shows. */
export function ThinkingBody(props: ThinkingBodyProps) {
  const Component = useContext(ThinkingBodyComponentContext);
  if (Component) return <Component {...props} />;
  return (
    <Markdown
      content={props.content}
      source="thinking"
      isStreaming={props.isStreaming}
    />
  );
}
