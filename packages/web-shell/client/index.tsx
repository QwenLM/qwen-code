import {
  DaemonSessionProvider,
  DaemonWorkspaceProvider,
} from '@qwen-code/webui/daemon-react-sdk';
import { App, type WebShellProps } from './App';

export interface WebShellWithProvidersProps extends WebShellProps {
  /** Daemon API base URL. Defaults to the browser origin when omitted. */
  baseUrl?: string;
  /** Bearer token passed to daemon requests. */
  token?: string;
  /** Initial daemon session id to load. Omit to create/attach automatically. */
  initialSessionId?: string;
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl) return baseUrl;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

/**
 * Low-level UI component. Requires ancestor `DaemonWorkspaceProvider` and
 * `DaemonSessionProvider` from `@qwen-code/webui/daemon-react-sdk`.
 */
export { App as WebShell };

/**
 * Batteries-included component for product integrations. It wraps WebShell
 * with both daemon providers, so MCP/tools/skills/memory/agents/session APIs
 * are available without extra setup.
 */
export function WebShellWithProviders({
  baseUrl,
  token,
  initialSessionId,
  ...webShellProps
}: WebShellWithProvidersProps) {
  const resolvedBaseUrl = resolveBaseUrl(baseUrl);

  return (
    <DaemonWorkspaceProvider baseUrl={resolvedBaseUrl} token={token}>
      <DaemonSessionProvider
        initialSessionId={initialSessionId}
        suppressOwnUserEcho
      >
        <App {...webShellProps} />
      </DaemonSessionProvider>
    </DaemonWorkspaceProvider>
  );
}

/** Alias for consumers who prefer a standalone naming style. */
export const StandaloneWebShell = WebShellWithProviders;

export type { WebShellProps } from './App';
export type { WebShellLanguage } from './i18n';
export type {
  MarkdownContentSource,
  MarkdownRenderContext,
  ToolHeaderExtraRenderer,
  ToolHeaderExtraRenderInfo,
  ToolHeaderKind,
  WebShellMarkdownCustomization,
} from './customization';
