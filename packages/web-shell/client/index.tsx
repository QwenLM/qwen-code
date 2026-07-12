import { useEffect, useState, type ReactNode } from 'react';
import {
  DaemonSessionProvider,
  DaemonWorkspaceProvider,
  useWorkspace,
} from '@qwen-code/webui/daemon-react-sdk';
import { App, type WebShellProps } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RootErrorFallback } from './components/RootErrorFallback';
import { Spinner } from './components/ui/spinner';
import { WorkspaceUnavailableState } from './components/WorkspaceUnavailableState';
import {
  getTranslator,
  normalizeLanguage,
  type WebShellLanguage,
} from './i18n';

export interface WebShellWithProvidersProps extends WebShellProps {
  /** Daemon API base URL. Defaults to the browser origin when omitted. */
  baseUrl?: string;
  /** Bearer token passed to daemon requests. */
  token?: string;
  /** Session id to load. Undefined starts on an empty page. */
  sessionId?: string;
  /** Registered daemon workspace id for the session. Undefined uses primary. */
  workspaceId?: string;
  /** Client identity to reuse when attaching to an externally created session. */
  clientId?: string;
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
  const { baseUrl, token, sessionId, workspaceId, clientId, ...webShellProps } =
    props;
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
        <WebShellSessionProvider
          sessionId={sessionId}
          workspaceId={workspaceId}
          clientId={clientId}
          webShellProps={webShellProps}
        />
      </DaemonWorkspaceProvider>
    </RootBoundary>
  );
}

function WebShellSessionProvider({
  sessionId,
  workspaceId,
  clientId,
  webShellProps,
}: {
  sessionId?: string;
  workspaceId?: string;
  clientId?: string;
  webShellProps: WebShellProps;
}) {
  const workspace = useWorkspace();
  const [usePrimaryNewSession, setUsePrimaryNewSession] = useState(false);
  useEffect(() => setUsePrimaryNewSession(false), [sessionId, workspaceId]);
  const effectiveSessionId = usePrimaryNewSession ? undefined : sessionId;
  const effectiveWorkspaceId = usePrimaryNewSession ? undefined : workspaceId;
  const targetWorkspace = workspace.capabilities?.workspaces?.find(
    (entry) => entry.id === effectiveWorkspaceId,
  );

  if (effectiveWorkspaceId && !workspace.capabilities) {
    const t = getTranslator(normalizeLanguage(webShellProps.language));
    return (
      <div
        data-web-shell-root
        data-web-shell-shadcn
        className={`flex min-h-32 w-full items-center justify-center gap-2 text-sm text-muted-foreground ${webShellProps.theme === 'dark' ? 'dark' : ''}`}
        role="status"
        aria-live="polite"
      >
        <Spinner />
        <span>{t('common.loading')}</span>
      </div>
    );
  }
  if (effectiveWorkspaceId && !targetWorkspace) {
    const t = getTranslator(normalizeLanguage(webShellProps.language));
    return (
      <WorkspaceUnavailableState
        title={t('workspace.notFound')}
        description={t('workspace.notFoundDescription')}
        actionLabel={t('session.new')}
        theme={webShellProps.theme}
        onAction={() => {
          setUsePrimaryNewSession(true);
          webShellProps.onSessionIdChange?.(undefined, undefined);
        }}
      />
    );
  }

  return (
    <DaemonSessionProvider
      key={effectiveWorkspaceId ?? 'primary'}
      sessionId={effectiveSessionId}
      workspaceCwd={targetWorkspace?.cwd}
      clientId={clientId}
      suppressOwnUserEcho
    >
      <App {...webShellProps} />
    </DaemonSessionProvider>
  );
}

/** Alias for consumers who prefer a standalone naming style. */
export const StandaloneWebShell = WebShellWithProviders;

export type { WebShellApi, WebShellProps, WebShellSidebarOptions } from './App';
export type { ToastTone } from './components/ToastHost';
export type { WebShellLanguage } from './i18n';
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
  AssistantTurnFooterRenderer,
  UserMessageContentRenderer,
  UserMessageContentRenderInfo,
  ComposerHeaderRenderer,
  ComposerToolbarStartRenderer,
  ComposerToolbarRightRenderer,
  WebShellComposerToolbarRenderInfo,
  WebShellComposerToolbarStartRenderInfo,
  WebShellComposerToolbarRightRenderInfo,
  WelcomeFooterRenderer,
  WelcomeHeaderRenderer,
  WebShellBottomStatusItem,
  WebShellCodeBlockRenderInfo,
  WebShellMarkdownCustomization,
  WebShellAssistantMessageInfo,
  WebShellAssistantTurnFooterRenderInfo,
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
