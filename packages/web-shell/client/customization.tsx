import { createContext, useContext, type ReactNode } from 'react';
import type { Components, Options } from 'react-markdown';
import type { ACPToolCall } from './adapters/types';
import type { WelcomeHeaderProps } from './components/WelcomeHeader';

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

export type WelcomeHeaderRenderer = (props: WelcomeHeaderProps) => ReactNode;

export interface WebShellComposerTag {
  id: string;
  label?: string;
  value?: string;
  removable?: boolean;
}

export type WebShellComposerTagPlacement = 'top' | 'inline';

export interface WebShellComposerTagOptions {
  placement?: WebShellComposerTagPlacement;
}

export interface WebShellComposerTextOptions {
  mode?: 'append' | 'replace';
}

export interface WebShellComposerInput {
  text?: string;
  tags?: readonly WebShellComposerTag[];
  tagPlacement?: WebShellComposerTagPlacement;
  submit?: boolean;
}

export interface WebShellComposerApi {
  insertText(text: string, options?: WebShellComposerTextOptions): void;
  setText(text: string): void;
  addTags(
    tags: readonly WebShellComposerTag[],
    options?: WebShellComposerTagOptions,
  ): void;
  removeTag(id: string): void;
  /** Clears text and/or top tags. Inline tags are part of the editor text. */
  clear(options?: { text?: boolean; tags?: boolean }): void;
  submit(input?: WebShellComposerInput): void;
}

export interface WebShellCustomization {
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  renderWelcomeHeader?: WelcomeHeaderRenderer;
  compactThinking?: boolean;
  markdown?: WebShellMarkdownCustomization;
}

const WebShellCustomizationContext = createContext<WebShellCustomization>({});

export const WebShellCustomizationProvider =
  WebShellCustomizationContext.Provider;

export function useWebShellCustomization(): WebShellCustomization {
  return useContext(WebShellCustomizationContext);
}
