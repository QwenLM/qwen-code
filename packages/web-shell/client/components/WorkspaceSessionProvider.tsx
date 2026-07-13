import { useEffect, useState } from 'react';
import { WifiOffIcon } from 'lucide-react';
import {
  DaemonSessionProvider,
  useWorkspace,
} from '@qwen-code/webui/daemon-react-sdk';
import { App, type WebShellProps } from '../App';
import { getTranslator, normalizeLanguage } from '../i18n';
import { Spinner } from './ui/spinner';
import { WorkspaceUnavailableState } from './WorkspaceUnavailableState';

interface WorkspaceSessionProviderProps {
  sessionId?: string;
  workspaceId?: string;
  clientId?: string;
  webShellProps: WebShellProps;
}

export function WorkspaceSessionProvider({
  sessionId,
  workspaceId,
  clientId,
  webShellProps,
}: WorkspaceSessionProviderProps) {
  const workspace = useWorkspace();
  const [usePrimaryNewSession, setUsePrimaryNewSession] = useState(false);
  useEffect(() => setUsePrimaryNewSession(false), [sessionId, workspaceId]);
  const effectiveSessionId = usePrimaryNewSession ? undefined : sessionId;
  const effectiveWorkspaceId = usePrimaryNewSession ? undefined : workspaceId;
  const targetWorkspace = workspace.capabilities?.workspaces?.find(
    (entry) => entry.id === effectiveWorkspaceId,
  );
  const t = getTranslator(normalizeLanguage(webShellProps.language));

  if (effectiveWorkspaceId && workspace.status === 'error') {
    return (
      <WorkspaceUnavailableState
        title={t('daemon.loadFailed')}
        description={t('workspace.loadFailedDescription')}
        actionLabel={t('common.retry')}
        theme={webShellProps.theme}
        icon={<WifiOffIcon />}
        onAction={() => {
          void workspace.refreshCapabilities?.().catch(() => {});
        }}
      />
    );
  }
  if (effectiveWorkspaceId && !workspace.capabilities) {
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
      key={`${effectiveWorkspaceId ?? 'primary'}:${effectiveSessionId ?? 'new'}`}
      sessionId={effectiveSessionId}
      workspaceCwd={targetWorkspace?.cwd}
      clientId={clientId}
      suppressOwnUserEcho
    >
      <App {...webShellProps} />
    </DaemonSessionProvider>
  );
}
