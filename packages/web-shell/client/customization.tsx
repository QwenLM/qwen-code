import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { Components, Options } from 'react-markdown';
import type { DaemonStreamingState } from '@qwen-code/webui/daemon-react-sdk';
import type { ACPToolCall } from './adapters/types';
import type { WelcomeHeaderProps } from './components/WelcomeHeader';
import type { WebShellTheme } from './themeContext';

export type MarkdownContentSource = 'assistant' | 'thinking';

export interface MarkdownRenderContext {
  source: MarkdownContentSource;
}

export interface WebShellCodeBlockRenderInfo {
  /**
   * Raw fenced-code language from the markdown class name, restricted to safe
   * fence-language characters.
   */
  language: string;
  /**
   * Canonical Shiki language id after applying built-in aliases, or `text`
   * when the language is unsupported by the fallback highlighter.
   */
  resolvedLanguage: string;
  className?: string;
  code: string;
  /** True while the assistant message is still streaming partial content. */
  isStreaming: boolean;
  source: MarkdownContentSource;
  theme: WebShellTheme;
}

/**
 * Return a React node to replace the default code block rendering. Return
 * `null`, `undefined`, or `false` to decline and fall back to the built-in code
 * block renderer. Expensive renderers should debounce or defer work while
 * `info.isStreaming` is true.
 */
export type CodeBlockRenderer = (
  info: WebShellCodeBlockRenderInfo,
) => ReactNode | null | undefined;

export interface WebShellMarkdownCustomization {
  transformMarkdown?: (
    markdown: string,
    context: MarkdownRenderContext,
  ) => string;
  renderCodeBlock?: CodeBlockRenderer;
  /**
   * Custom markdown components override Web Shell's built-ins. In particular,
   * `components.code` replaces the default code renderer, so `renderCodeBlock`
   * will not be called for that source.
   */
  components?: Components;
  remarkPlugins?: Options['remarkPlugins'];
  rehypePlugins?: Options['rehypePlugins'];
}

export type MarkdownTableMode = 'basic' | 'advanced';

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
export type WelcomeFooterRenderer = (props: WelcomeHeaderProps) => ReactNode;

export type WebShellComposerTagKind = 'extension' | 'mcp' | 'file' | 'skill';

export interface WebShellComposerTag {
  id: string;
  label?: string;
  value?: string;
  removable?: boolean;
  kind?: WebShellComposerTagKind;
  serialized?: string;
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

export interface WebShellAtItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  insertText?: string;
}

export interface WebShellAtProvider {
  id: string;
  label: string;
  description?: string;
  order?: number;
  search(params: {
    query: string;
    signal: AbortSignal;
  }): Promise<readonly WebShellAtItem[]>;
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

export interface WebShellComposerToolbarRenderInfo {
  disabled: boolean;
  isRunning: boolean;
  currentMode: string;
  currentModel: string;
  sessionName?: string;
}

export type WebShellComposerToolbarStartRenderInfo =
  WebShellComposerToolbarRenderInfo;

export type WebShellComposerToolbarRightRenderInfo =
  WebShellComposerToolbarRenderInfo;

export type ComposerToolbarStartRenderer =
  ComponentType<WebShellComposerToolbarStartRenderInfo>;

export type ComposerToolbarEndRenderer =
  ComponentType<WebShellComposerToolbarRenderInfo>;

export type ComposerToolbarRightRenderer =
  ComponentType<WebShellComposerToolbarRightRenderInfo>;

// ---- Background task info (public type for footer renderer) ----

interface WebShellTaskBase {
  id: string;
  label: string;
  description: string;
  runtimeMs: number;
  startTime: number;
  endTime?: number;
  error?: string;
}

export interface WebShellAgentTask extends WebShellTaskBase {
  kind: 'agent';
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  subagentType?: string;
  isBackgrounded: boolean;
  prompt?: string;
}

export interface WebShellShellTask extends WebShellTaskBase {
  kind: 'shell';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  command: string;
  cwd: string;
  pid?: number;
  exitCode?: number;
}

export interface WebShellMonitorTask extends WebShellTaskBase {
  kind: 'monitor';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  command: string;
  pid?: number;
  exitCode?: number;
}

export type WebShellTaskInfo =
  | WebShellAgentTask
  | WebShellShellTask
  | WebShellMonitorTask;

// ---- Model info (public type for footer renderer) ----

export interface WebShellModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
}

// ---- Skill info (public type for footer renderer) ----

export interface WebShellSkillInfo {
  name: string;
  description: string;
}

// ---- Footer renderer ----

export interface WebShellFooterRenderInfo {
  connected: boolean;
  mode: string;
  model: string;
  streamingState: DaemonStreamingState;
  contextUsageRatio: number;
  activeGoal: { condition: string; setAt: number } | null;
  tasks: readonly WebShellTaskInfo[];
  availableModes: readonly string[];
  availableModels: readonly WebShellModelInfo[];
  skills: readonly WebShellSkillInfo[];

  onSelectMode: (mode: string) => void;
  onSelectModel: (model: string) => void;
}

export type FooterRenderer = ComponentType<WebShellFooterRenderInfo>;

// ---- Loading phrases ----

/**
 * Resolves the witty phrases cycled while a prompt is streaming. Receives the
 * resolved UI language. Return phrases to override the built-in defaults, an
 * empty array to hide the phrase entirely, or `undefined`/`null` to fall back
 * to the built-in defaults for that language.
 */
export type LoadingPhrasesResolver = (
  language: string,
) => readonly string[] | undefined | null;

export interface WebShellCustomization {
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  renderWelcomeHeader?: WelcomeHeaderRenderer;
  renderWelcomeFooter?: WelcomeFooterRenderer;
  renderComposerToolbarStart?: ComposerToolbarStartRenderer;
  renderComposerToolbarEnd?: ComposerToolbarEndRenderer;
  renderComposerToolbarRight?: ComposerToolbarRightRenderer;
  renderFooter?: FooterRenderer;
  compactThinking?: boolean;
  /**
   * Auto-collapse each completed turn's intermediate steps (thinking, tool
   * calls, mid-turn assistant text) behind a toggle on the prompt row, leaving
   * just the prompt and the final answer. The active turn always stays
   * expanded. Defaults to enabled when unset.
   */
  collapseCompletedTurns?: boolean;
  markdownTableMode?: MarkdownTableMode;
  markdown?: WebShellMarkdownCustomization;
  loadingPhrases?: LoadingPhrasesResolver;
}

const WebShellCustomizationContext = createContext<WebShellCustomization>({});

export const WebShellCustomizationProvider =
  WebShellCustomizationContext.Provider;

export function useWebShellCustomization(): WebShellCustomization {
  return useContext(WebShellCustomizationContext);
}
