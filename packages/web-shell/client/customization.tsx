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
export type WelcomeFooterRenderer = (props: WelcomeHeaderProps) => ReactNode;

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

export interface WebShellComposerToolbarStartRenderInfo {
  disabled: boolean;
  isRunning: boolean;
  currentMode: string;
  currentModel: string;
  sessionName?: string;
}

export type ComposerToolbarStartRenderer =
  ComponentType<WebShellComposerToolbarStartRenderInfo>;

export type ComposerToolbarEndRenderer =
  ComponentType<WebShellComposerToolbarStartRenderInfo>;

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

export interface WebShellCustomization {
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  renderWelcomeHeader?: WelcomeHeaderRenderer;
  renderWelcomeFooter?: WelcomeFooterRenderer;
  renderComposerToolbarStart?: ComposerToolbarStartRenderer;
  renderComposerToolbarEnd?: ComposerToolbarEndRenderer;
  renderFooter?: FooterRenderer;
  compactThinking?: boolean;
  /**
   * Auto-collapse each completed turn's intermediate steps (thinking, tool
   * calls, mid-turn assistant text) behind a toggle on the prompt row, leaving
   * just the prompt and the final answer. The active turn always stays
   * expanded. Defaults to enabled when unset.
   */
  collapseCompletedTurns?: boolean;
  markdown?: WebShellMarkdownCustomization;
}

const WebShellCustomizationContext = createContext<WebShellCustomization>({});

export const WebShellCustomizationProvider =
  WebShellCustomizationContext.Provider;

export function useWebShellCustomization(): WebShellCustomization {
  return useContext(WebShellCustomizationContext);
}
