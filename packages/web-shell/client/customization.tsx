import { createContext, useContext, type ReactNode } from 'react';
import type { Components, Options } from 'react-markdown';
import type { ACPToolCall } from './adapters/types';

export type MarkdownContentSource = 'assistant' | 'thinking';

export interface MarkdownRenderContext {
  source: MarkdownContentSource;
}

export interface WebShellMarkdownCustomization {
  transformMarkdown?: (
    markdown: string,
    context: MarkdownRenderContext,
  ) => string;
  components?: Components;
  remarkPlugins?: Options['remarkPlugins'];
  rehypePlugins?: Options['rehypePlugins'];
}

export type ToolHeaderKind =
  | 'agent'
  | 'edit'
  | 'fetch'
  | 'read'
  | 'shell'
  | 'todo'
  | 'write'
  | 'other';

export interface ToolHeaderExtraRenderInfo {
  kind: ToolHeaderKind;
  tool: ACPToolCall;
  displayName: string;
  description: string;
  elapsed: string;
  workspaceCwd?: string;
}

export type ToolHeaderExtraRenderer = (
  info: ToolHeaderExtraRenderInfo,
) => ReactNode;

export interface WebShellCustomization {
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  markdown?: WebShellMarkdownCustomization;
}

const WebShellCustomizationContext = createContext<WebShellCustomization>({});

export const WebShellCustomizationProvider =
  WebShellCustomizationContext.Provider;

export function useWebShellCustomization(): WebShellCustomization {
  return useContext(WebShellCustomizationContext);
}
