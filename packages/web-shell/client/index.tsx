import { type ReactNode } from 'react';
import { DaemonWorkspaceProvider } from '@qwen-code/webui/daemon-react-sdk';
import { App, type WebShellProps } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RootErrorFallback } from './components/RootErrorFallback';
import { WorkspaceSessionProvider } from './components/WorkspaceSessionProvider';
import { normalizeLanguage, type WebShellLanguage } from './i18n';
export { WebShellTranscript } from './components/WebShellTranscript';
export type { WebShellTranscriptProps } from './components/WebShellTranscript';

export interface WebShellWithProvidersProps extends WebShellProps {
  /** Daemon API base URL. Defaults to the browser origin when omitted. */
  baseUrl?: string;
  /** Bearer token passed to daemon requests. */
  token?: string;
  /** Session id to load. Undefined starts on an empty page. */
  sessionId?: string;
  /** Registered daemon workspace id for the session. Undefined uses primary. */
  workspaceId?: string;
  /** Registered daemon workspace path for the session. Takes precedence over workspaceId. */
  workspaceCwd?: string;
  /**
   * Workspace path to lock this shell to. Missing paths are registered
   * persistently before rendering. Takes precedence over workspaceCwd and workspaceId.
   */
  lockWorkspaceCwd?: string;
  /** Client identity to reuse when attaching to an externally created session. */
  clientId?: string;
  /** Restart the SSE event stream after each accepted prompt. Disabled by default. */
  restartSseOnPrompt?: boolean;
  /** Persisted transcript records requested per page. Defaults to 100; valid range is 1–500. */
  historyPageSize?: number;
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl) return baseUrl;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

/**
 * Top-level boundary so a catastrophic render failure degrades to a recoverable
 * fallback instead of taking down the host page. Place it at the outermost point
 * each entry owns: a boundary nested *inside* the daemon providers can't catch a
 * throw from the providers themselves, so the batteries-included paths wrap the
 * providers too.
 */
function RootBoundary({
  language,
  children,
}: {
  language?: WebShellLanguage;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      label="web-shell-root"
      fallback={(error, reset) => (
        <RootErrorFallback error={error} onRetry={reset} language={language} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * Low-level UI component. Requires ancestor `DaemonWorkspaceProvider` and
 * `DaemonSessionProvider` from `@qwen-code/webui/daemon-react-sdk`. The consumer
 * owns those providers, so this boundary covers only what we render (`App`).
 */
export function WebShell(props: WebShellProps) {
  return (
    <RootBoundary
      language={props.language ? normalizeLanguage(props.language) : undefined}
    >
      <App {...props} />
    </RootBoundary>
  );
}

/**
 * Batteries-included component for product integrations. It wraps WebShell
 * with both daemon providers, so MCP/tools/skills/memory/agents/session APIs
 * are available without extra setup.
 */
export function WebShellWithProviders(props: WebShellWithProvidersProps) {
  const {
    baseUrl,
    token,
    sessionId,
    workspaceId,
    workspaceCwd,
    lockWorkspaceCwd,
    clientId,
    restartSseOnPrompt,
    historyPageSize,
    ...webShellProps
  } = props;
  const resolvedBaseUrl = resolveBaseUrl(baseUrl);

  return (
    <RootBoundary
      language={
        webShellProps.language
          ? normalizeLanguage(webShellProps.language)
          : undefined
      }
    >
      <DaemonWorkspaceProvider baseUrl={resolvedBaseUrl} token={token}>
        <WorkspaceSessionProvider
          sessionId={sessionId}
          workspaceId={workspaceId}
          workspaceCwd={workspaceCwd}
          lockWorkspaceCwd={lockWorkspaceCwd}
          clientId={clientId}
          restartSseOnPrompt={restartSseOnPrompt}
          historyPageSize={historyPageSize}
          webShellProps={webShellProps}
        />
      </DaemonWorkspaceProvider>
    </RootBoundary>
  );
}

/** Alias for consumers who prefer a standalone naming style. */
export const StandaloneWebShell = WebShellWithProviders;

export type {
  WebShellApi,
  WebShellComposerPlaceholders,
  WebShellComposerPlaceholderState,
  WebShellSlashCommand,
  WebShellSlashCommandHandler,
  WebShellProps,
  WebShellSidebarOptions,
  BugReportInfo,
  SessionChangeEvent,
} from './App';
export type { ToastTone } from './components/ToastHost';
export type {
  WebShellSidebarBranding,
  WebShellSidebarFooterItem,
  WebShellSidebarFooterOptions,
  WebShellSidebarLockedWorkspace,
} from './components/sidebar/WebShellSidebar';
export type { WebShellLanguage } from './i18n';
export type { WebShellTheme } from './themeContext';
export type {
  CommandDisplayCategory,
  CommandDisplayCategoryOrder,
} from './utils/commandDisplay';
export type { ComposerToolbarAction } from './components/ChatEditor';
export type {
  CodeBlockRenderer,
  MarkdownContentSource,
  MarkdownTableMode,
  MarkdownRenderContext,
  ToolHeaderExtraRenderer,
  ToolHeaderExtraRenderInfo,
  ToolHeaderKind,
  ComposerTagClickHandler,
  ComposerTagRenderer,
  AssistantTurnFooterRenderer,
  UserMessageContentRenderer,
  UserMessageContentRenderInfo,
  UserMessageContentParser,
  ComposerHeaderRenderer,
  ComposerToolbarStartRenderer,
  ComposerToolbarRightRenderer,
  WebShellAtItemRenderInfo,
  WebShellAtItemRenderer,
  WebShellComposerApi,
  WebShellBuiltinComposerTagKind,
  WebShellBuiltinAtProviderId,
  WebShellBuiltinAtProvidersConfig,
  WebShellComposerInput,
  WebShellComposerTag,
  WebShellComposerTagIconMap,
  WebShellComposerTagKind,
  WebShellComposerTagOptions,
  WebShellComposerTagPlacement,
  WebShellComposerToolbarRenderInfo,
  WebShellComposerToolbarStartRenderInfo,
  WebShellComposerToolbarRightRenderInfo,
  WebShellComposerTextOptions,
  WelcomeFooterRenderer,
  WelcomeHeaderRenderer,
  WebShellFooterRenderInfo,
  FooterRenderer,
  LoadingPhrasesResolver,
  WebShellAtProviderTab,
  WebShellAtItem,
  WebShellAtProvider,
  WebShellBottomStatusItem,
  WebShellCodeBlockRenderInfo,
  WebShellMarkdownCustomization,
  WebShellAssistantMessageInfo,
  WebShellAssistantTurnFooterRenderInfo,
  WebShellIconSource,
  WebShellTaskInfo,
  WebShellUserMessagePart,
  WebShellAgentTask,
  WebShellShellTask,
  WebShellMonitorTask,
  WebShellModelInfo,
  WebShellSkillInfo,
} from './customization';
export type { WelcomeHeaderProps } from './components/WelcomeHeader';
export type {
  TurnOutputKind,
  TurnOutputOpenRequest,
} from './components/artifacts/TurnOutputs';
export {
  ECHARTS_FULLDATA_LANGUAGE,
  EchartsFullDataBlock,
  createEchartsFullDataRenderer,
} from './components/messages/EchartsFullDataBlock';
export type {
  DatasetCell,
  EchartsFullDataBlockProps,
  EchartsFullDataOption,
  EchartsFullDataRefMeta,
  EchartsFullDataRefResolver,
  EchartsFullDataResolvedDataset,
  EchartsFullDataRendererOptions,
  EchartsInstance,
  EchartsRuntime,
  EchartsRuntimeLoader,
} from './components/messages/EchartsFullDataBlock';
