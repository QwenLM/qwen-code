import {
  createContext,
  useContext,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { Components, Options } from 'react-markdown';
import type {
  ChartRendererRegistry,
  MarkdownChartLabelOverrides,
} from '@datafe-open/markdown-chart';
import type { MarkdownChartReactErrorHandler } from '@datafe-open/markdown-chart-react';
import type {
  DaemonInputAnnotation,
  GoalSnapshotV2,
} from '@qwen-code/sdk/daemon';
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
  /** True only when this block is the active unterminated tail fence. */
  isIncomplete: boolean;
  source: MarkdownContentSource;
  theme: WebShellTheme;
}

/**
 * Return a React node to replace the default code block rendering. Return
 * `null`, `undefined`, or `false` to decline and fall back to the built-in code
 * block renderer. Expensive renderers should defer parsing while
 * `info.isIncomplete` is true; `info.isStreaming` describes the surrounding
 * assistant message and may remain true after this block has closed.
 */
export type CodeBlockRenderer = (
  info: WebShellCodeBlockRenderInfo,
) => ReactNode | null | undefined;

export interface WebShellMarkdownChartCustomization {
  registry: ChartRendererRegistry;
  loadingLabel?: string;
  labels?: MarkdownChartLabelOverrides;
  onError?: MarkdownChartReactErrorHandler;
  chartClassName?: string;
  chartStyle?: CSSProperties;
}

export interface WebShellMarkdownCustomization {
  transformMarkdown?: (
    markdown: string,
    context: MarkdownRenderContext,
  ) => string;
  /**
   * Override Web Shell's built-in Markdown chart registry or its presentation
   * callbacks. The complete chart customization object must remain
   * referentially stable while a chart is mounted.
   */
  chart?: WebShellMarkdownChartCustomization;
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
  | 'ask'
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

export type WebShellChatHeaderItem =
  | 'title'
  | 'environment'
  | 'rightPanel'
  | 'tokenUsage';

export interface WebShellChatHeaderOptions {
  /** Built-in header actions to show. Token usage is opt-in. */
  items?: readonly WebShellChatHeaderItem[];
}

export type WebShellRightPanelItem = 'review' | 'sideTask' | 'terminal';

export interface WebShellRightPanelOptions {
  /** Empty-state actions to show. Defaults to all actions. */
  items?: readonly WebShellRightPanelItem[];
}

export type WebShellEnvironmentPanelItem =
  | 'environment'
  | 'subagents'
  | 'backgroundTasks';

export interface WebShellEnvironmentPanelOptions {
  /** Sections to show. Defaults to all sections. */
  items?: readonly WebShellEnvironmentPanelItem[];
}

/** Context passed to the chat header renderer. */
export interface ChatHeaderRenderInfo {
  /** Current session id, if connected. */
  sessionId?: string;
  /** Display name for the current session. */
  sessionName?: string;
  /** Workspace cwd for the current session. */
  workspaceCwd?: string;
  /** Header actions enabled by the host. */
  items: readonly WebShellChatHeaderItem[];
  /** Whether the environment panel is currently open. */
  environmentPanelOpen: boolean;
  /** Whether the right extension panel is currently open. */
  rightPanelOpen: boolean;
  /** Opens or closes the environment panel. */
  onEnvironmentPanelOpenChange: (open: boolean) => void;
  /** Opens or closes the right extension panel. */
  onRightPanelOpenChange: (open: boolean) => void;
  /** Opens token usage for the current session, when available. */
  onOpenTokenUsage?: () => void;
  /** Opens Settings deep-linked to Local Control (Daemon category). */
  onOpenLocalControlSettings?: () => void;
}

/**
 * Replaces the complete persistent chat header. Only rendered when a session
 * is active (not in the welcome/empty state).
 */
export type ChatHeaderRenderer = (info: ChatHeaderRenderInfo) => ReactNode;

export interface UserMessageContentRenderInfo {
  content: string;
  images?: readonly { data: string; mimeType: string }[];
  files?: readonly {
    name: string;
    mimeType: string;
    data?: Blob;
    text?: string;
    attachmentId?: string;
  }[];
  inputAnnotations?: readonly DaemonInputAnnotation[];
}

export interface WebShellPreparedSubmit {
  prompt: string;
  inputAnnotations?: readonly DaemonInputAnnotation[];
}

export interface WebShellSubmitSnapshot {
  sessionId?: string;
  prompt: string;
  inputAnnotations: readonly DaemonInputAnnotation[];
}

export type UserMessageContentRenderer = (
  info: UserMessageContentRenderInfo,
) => ReactNode;

export interface WebShellBottomStatusItem {
  id: string;
  label: ReactNode;
  title?: string;
  ariaLabel?: string;
  onClick?: () => void;
}

export type WebShellIconSource = string;

export interface WebShellAssistantMessageInfo {
  id: string;
  content: string;
  isStreaming?: boolean;
  timestamp?: number;
}

export interface WebShellAssistantTurnFooterRenderInfo {
  /** User-message id for the head of the completed turn. */
  turnId: string;
  message: WebShellAssistantMessageInfo;
}

export type AssistantTurnFooterRenderer = (
  info: WebShellAssistantTurnFooterRenderInfo,
) => ReactNode | null | undefined;

export type WebShellBuiltinComposerTagKind =
  | 'extension'
  | 'mcp'
  | 'file'
  | 'skill';

export type WebShellComposerTagKind =
  | WebShellBuiltinComposerTagKind
  | (string & {});

export type WebShellComposerTagIconMap = Readonly<Record<string, string>>;

export interface WebShellComposerTag {
  id: string;
  label?: string;
  value?: string;
  removable?: boolean;
  kind?: WebShellComposerTagKind;
  icon?: WebShellIconSource;
  metadata?: unknown;
  serialized?: string;
}

export type WebShellComposerTagPlacementContext = 'composer' | 'user-message';

export interface WebShellComposerTagRenderInfo {
  tag: WebShellComposerTag;
  placement: WebShellComposerTagPlacementContext;
  readonly: boolean;
  anchorRect?: DOMRectReadOnly;
}

/**
 * Custom composer tag content. Inline composer tags are mounted from
 * CodeMirror-managed React roots, so JSX returned for inline tags must not
 * depend on React context from the surrounding app tree.
 */
export type ComposerTagRenderer = (
  info: WebShellComposerTagRenderInfo,
) => ReactNode | null | undefined;

export type ComposerTagClickHandler = (
  info: WebShellComposerTagRenderInfo,
) => void;

export type WebShellUserMessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tag';
      tag: WebShellComposerTag;
      sourceRange?: readonly [number, number];
    };

export type UserMessageContentParser = (
  content: string,
) => readonly WebShellUserMessagePart[] | undefined | null;

export type WebShellComposerTagPlacement = 'top' | 'inline';

export interface WebShellComposerTagOptions {
  placement?: WebShellComposerTagPlacement;
  /**
   * Inline placement only: insert at the caret (default, synchronous user
   * gestures) or append after the document end (asynchronous producers,
   * which must not interrupt typing or steal focus).
   */
  position?: 'caret' | 'end';
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
  subtitle?: string;
  description?: string;
  detail?: string;
  icon?: WebShellIconSource;
  iconMode?: 'mask' | 'image';
  iconColor?: string;
  iconSpin?: boolean;
  iconTooltip?: string;
  insertText?: string;
  composerTag?: WebShellComposerTag;
}

export type WebShellBuiltinAtProviderId =
  | 'files'
  | 'extensions'
  | 'mcp-resources';

export type WebShellBuiltinAtProvidersConfig =
  | boolean
  | readonly WebShellBuiltinAtProviderId[]
  | {
      enabled?: boolean;
      include?: readonly WebShellBuiltinAtProviderId[];
      exclude?: readonly WebShellBuiltinAtProviderId[];
    };

export interface WebShellAtProviderTab {
  id: string;
  label: ReactNode;
  textValue?: string;
  disabled?: boolean;
}

export interface WebShellAtItemRenderInfo {
  item: WebShellAtItem;
  provider: WebShellAtProvider;
  selected: boolean;
}

export type WebShellAtItemRenderer = (
  info: WebShellAtItemRenderInfo,
) => ReactNode | null | undefined;

export interface WebShellAtProvider {
  id: string;
  label: ReactNode;
  textValue?: string;
  description?: string;
  order?: number;
  tabs?: readonly WebShellAtProviderTab[];
  renderItem?: WebShellAtItemRenderer;
  search(params: {
    query: string;
    signal: AbortSignal;
    tabId?: string;
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

export type ComposerHeaderRenderer =
  ComponentType<WebShellComposerToolbarRenderInfo>;

export type ComposerFooterRenderer =
  ComponentType<WebShellComposerToolbarRenderInfo>;

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
  /** Canonical daemon-owned Goal state for the active session. */
  goalSnapshot: GoalSnapshotV2 | null;
  /** @deprecated Prefer goalSnapshot. */
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
  parseUserMessageContent?: UserMessageContentParser;
  renderUserMessageContent?: UserMessageContentRenderer;
  composerTagIcons?: WebShellComposerTagIconMap;
  /**
   * Built-in / host @ mention providers. Split-view panes share this context
   * so they match the main composer without ChatPane prop drilling.
   */
  builtinAtProviders?: WebShellBuiltinAtProvidersConfig;
  atProviders?: readonly WebShellAtProvider[];
  renderComposerTag?: ComposerTagRenderer;
  renderComposerTagTooltip?: ComposerTagRenderer;
  onComposerTagClick?: ComposerTagClickHandler;
  renderAssistantTurnFooter?: AssistantTurnFooterRenderer;
  renderComposerToolbarStart?: ComposerToolbarStartRenderer;
  renderComposerToolbarEnd?: ComposerToolbarEndRenderer;
  renderComposerToolbarRight?: ComposerToolbarRightRenderer;
  renderComposerHeader?: ComposerHeaderRenderer;
  renderComposerFooter?: ComposerFooterRenderer;
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
  /**
   * Controls whether the composer's file-upload entry points (drag-and-drop
   * and the @ panel upload item) are enabled. Works alongside the daemon's
   * `workspace_file_upload` capability, not instead of it: setting `false`
   * force-disables upload even when the daemon advertises the capability,
   * while `true`/omitted still requires the capability (and the workspace
   * trust / qualified-route safety checks) to be satisfied.
   */
  fileUploadEnabled?: boolean;
  /**
   * Directory that drag-and-dropped files upload into, **relative to the
   * workspace root**. Use a relative path WITHOUT a leading `/` — e.g.
   * `'uploads'`, `'uploads/images'`, or omit it to upload into the
   * workspace root (the default). A leading-slash path like `'/uploads'`
   * is rejected by the daemon as outside the workspace. The directory
   * (including intermediate components) is created automatically on upload
   * when it does not exist.
   */
  fileUploadDirectory?: string;
}

const WebShellCustomizationContext = createContext<WebShellCustomization>({});

export const WebShellCustomizationProvider =
  WebShellCustomizationContext.Provider;

export function useWebShellCustomization(): WebShellCustomization {
  return useContext(WebShellCustomizationContext);
}
