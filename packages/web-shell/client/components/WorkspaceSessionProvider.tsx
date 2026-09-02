import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WifiOffIcon } from 'lucide-react';
import {
  DaemonSessionProvider,
  useWorkspace,
  useWorkspaceActions,
  type DaemonProductSessionContext,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  isStandaloneSessionNotFoundError,
  STANDALONE_SESSIONS_CAPABILITY,
  type DaemonStandaloneSessionLookup,
  type DaemonStandaloneSessionSummary,
  type DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { App, type WebShellProps } from '../App';
import {
  WEB_SHELL_HISTORY_PAGE_SIZE,
  WEB_SHELL_MAX_TRANSCRIPT_BLOCKS,
} from '../constants/sessions';
import { getTranslator, normalizeLanguage } from '../i18n';
import { Spinner } from './ui/spinner';
import { WorkspaceUnavailableState } from './WorkspaceUnavailableState';
interface WorkspaceSessionProviderProps {
  sessionId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  sessionContext?: DaemonProductSessionContext;
  lockWorkspaceCwd?: string;
  clientId?: string;
  extensionPairingCredential?: string;
  restartSseOnPrompt?: boolean;
  historyPageSize?: number;
  webShellProps: WebShellProps;
}

export function WorkspaceSessionProvider(props: WorkspaceSessionProviderProps) {
  const {
    sessionId,
    workspaceId,
    workspaceCwd,
    sessionContext,
    lockWorkspaceCwd,
    clientId,
    restartSseOnPrompt,
    historyPageSize = WEB_SHELL_HISTORY_PAGE_SIZE,
    webShellProps,
  } = props;
  const onSessionIdChange = webShellProps.onSessionIdChange;
  const attachedStandaloneSessionIdRef = useRef<string | undefined>(undefined);
  const handleSessionIdChange = useCallback<
    NonNullable<WebShellProps['onSessionIdChange']>
  >(
    (nextSessionId, nextWorkspaceId, nextWorkspaceCwd, nextSessionContext) => {
      attachedStandaloneSessionIdRef.current =
        nextSessionContext?.kind === 'standalone' ? nextSessionId : undefined;
      onSessionIdChange?.(
        nextSessionId,
        nextWorkspaceId,
        nextWorkspaceCwd,
        nextSessionContext,
      );
    },
    [onSessionIdChange],
  );
  if (
    sessionContext?.kind !== 'standalone' ||
    (attachedStandaloneSessionIdRef.current !== undefined &&
      attachedStandaloneSessionIdRef.current !== sessionId)
  ) {
    attachedStandaloneSessionIdRef.current = undefined;
  }
  const t = getTranslator(normalizeLanguage(webShellProps.language));
  const contextConflictsWithWorkspace =
    sessionContext?.kind !== undefined &&
    sessionContext.kind !== 'workspace' &&
    Boolean(lockWorkspaceCwd || workspaceCwd || workspaceId);

  if (contextConflictsWithWorkspace) {
    return (
      <WorkspaceUnavailableState
        title={t('session.loadFailed')}
        description={t('session.contextConflict')}
        theme={webShellProps.theme}
        icon={<WifiOffIcon />}
      />
    );
  }

  if (sessionContext?.kind === 'standalone') {
    return (
      <StandaloneSessionGate
        sessionId={sessionId}
        attachedSessionId={attachedStandaloneSessionIdRef.current}
        clientId={clientId}
        restartSseOnPrompt={restartSseOnPrompt}
        historyPageSize={historyPageSize}
        webShellProps={{
          ...webShellProps,
          onSessionIdChange: onSessionIdChange
            ? handleSessionIdChange
            : undefined,
        }}
      />
    );
  }

  return <WorkspaceSessionProviderWorkspace {...props} />;
}

function WorkspaceSessionProviderWorkspace({
  sessionId,
  workspaceId,
  workspaceCwd,
  sessionContext,
  lockWorkspaceCwd,
  clientId,
  extensionPairingCredential,
  restartSseOnPrompt,
  historyPageSize = WEB_SHELL_HISTORY_PAGE_SIZE,
  webShellProps,
}: WorkspaceSessionProviderProps) {
  const workspace = useWorkspace();
  const workspaceActions = useWorkspaceActions();
  const [usePrimaryNewSession, setUsePrimaryNewSession] = useState(false);
  const [registeredWorkspace, setRegisteredWorkspace] = useState<{
    requestedCwd: string;
    workspace: DaemonWorkspaceCapability;
  }>();
  const [registrationErrorCwd, setRegistrationErrorCwd] = useState<string>();
  const registrationRef = useRef<
    | {
        cwd: string;
        promise: Promise<DaemonWorkspaceCapability>;
      }
    | undefined
  >(undefined);
  useEffect(
    () => setUsePrimaryNewSession(false),
    [sessionContext, sessionId, lockWorkspaceCwd, workspaceCwd, workspaceId],
  );
  const effectiveSessionId = usePrimaryNewSession ? undefined : sessionId;
  const effectiveWorkspaceCwd = usePrimaryNewSession
    ? undefined
    : (lockWorkspaceCwd ??
      workspaceCwd ??
      (sessionContext?.kind === 'workspace' ? sessionContext.cwd : undefined));
  const effectiveWorkspaceId = effectiveWorkspaceCwd ? undefined : workspaceId;
  const pathWorkspace = useMemo(() => {
    const listedWorkspace = workspace.capabilities?.workspaces?.find(
      (entry) => entry.cwd === effectiveWorkspaceCwd,
    );
    if (listedWorkspace) return listedWorkspace;
    if (
      effectiveWorkspaceCwd &&
      effectiveWorkspaceCwd === workspace.capabilities?.workspaceCwd
    ) {
      return {
        id: 'primary',
        cwd: effectiveWorkspaceCwd,
        primary: true,
        trusted: true,
      };
    }
    return undefined;
  }, [
    effectiveWorkspaceCwd,
    workspace.capabilities?.workspaceCwd,
    workspace.capabilities?.workspaces,
  ]);
  const registeredLockedWorkspace =
    lockWorkspaceCwd && registeredWorkspace?.requestedCwd === lockWorkspaceCwd
      ? registeredWorkspace.workspace
      : undefined;
  const targetWorkspace = effectiveWorkspaceCwd
    ? (pathWorkspace ?? registeredLockedWorkspace)
    : workspace.capabilities?.workspaces?.find(
        (entry) => entry.id === effectiveWorkspaceId,
      );
  const t = useMemo(
    () => getTranslator(normalizeLanguage(webShellProps.language)),
    [webShellProps.language],
  );

  useEffect(() => {
    if (!lockWorkspaceCwd || !workspace.capabilities || pathWorkspace) return;
    if (registeredWorkspace?.requestedCwd === lockWorkspaceCwd) return;
    if (registrationErrorCwd === lockWorkspaceCwd) return;

    if (registrationRef.current?.cwd !== lockWorkspaceCwd) {
      registrationRef.current = {
        cwd: lockWorkspaceCwd,
        promise: workspaceActions
          .addWorkspace(lockWorkspaceCwd, { persist: true })
          .then((result) => {
            if (result.persisted !== true) {
              throw new Error('Workspace registration was not persisted');
            }
            return result;
          }),
      };
    }

    let cancelled = false;
    void registrationRef.current.promise
      .then(async (result) => {
        if (cancelled) return;
        setRegisteredWorkspace({
          requestedCwd: lockWorkspaceCwd,
          workspace: result,
        });
        setRegistrationErrorCwd(undefined);
        try {
          await workspace.refreshCapabilities?.();
        } catch {
          // Registration succeeded; a later capabilities refresh can reconcile.
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRegistrationErrorCwd(lockWorkspaceCwd);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    pathWorkspace,
    registeredWorkspace,
    registrationErrorCwd,
    workspace,
    workspace.capabilities,
    workspace.refreshCapabilities,
    workspaceActions,
    lockWorkspaceCwd,
  ]);

  if (
    (effectiveWorkspaceCwd || effectiveWorkspaceId) &&
    workspace.status === 'error'
  ) {
    return (
      <WorkspaceUnavailableState
        title={t('workspace.loadFailed')}
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
  if (
    (effectiveWorkspaceCwd || effectiveWorkspaceId) &&
    !workspace.capabilities
  ) {
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
  if (lockWorkspaceCwd && registrationErrorCwd === lockWorkspaceCwd) {
    return (
      <WorkspaceUnavailableState
        title={t('workspace.loadFailed')}
        description={t('workspace.loadFailedDescription')}
        actionLabel={t('common.retry')}
        theme={webShellProps.theme}
        icon={<WifiOffIcon />}
        onAction={() => {
          registrationRef.current = undefined;
          setRegistrationErrorCwd(undefined);
        }}
      />
    );
  }
  if (lockWorkspaceCwd && !targetWorkspace) {
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
  if ((effectiveWorkspaceCwd || effectiveWorkspaceId) && !targetWorkspace) {
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
      key="main-session"
      sessionId={effectiveSessionId}
      sessionContext={
        usePrimaryNewSession
          ? undefined
          : (sessionContext ??
            (targetWorkspace
              ? { kind: 'workspace', cwd: targetWorkspace.cwd }
              : undefined))
      }
      workspaceCwd={
        sessionContext?.kind === 'workspace' || !sessionContext
          ? targetWorkspace?.cwd
          : undefined
      }
      clientId={clientId}
      createSessionRequest={
        extensionPairingCredential ? { extensionPairingCredential } : undefined
      }
      historyPageSize={historyPageSize}
      subagentTranscriptMode="summary"
      maxBlocks={WEB_SHELL_MAX_TRANSCRIPT_BLOCKS}
      suppressOwnUserEcho
      restartEventStreamOnPrompt={restartSseOnPrompt}
    >
      <App
        {...webShellProps}
        historyPageSize={historyPageSize}
        restartSseOnPrompt={restartSseOnPrompt}
        initialSelectedWorkspaceCwd={
          !lockWorkspaceCwd && targetWorkspace ? targetWorkspace.cwd : undefined
        }
        lockedWorkspaceCwd={lockWorkspaceCwd ? targetWorkspace?.cwd : undefined}
        lockedWorkspaceCapability={
          lockWorkspaceCwd ? targetWorkspace : undefined
        }
      />
    </DaemonSessionProvider>
  );
}

const STANDALONE_LOOKUP_DELAYS_MS = [250, 500, 1000, 2000, 4000, 4000];

type StandaloneResolution =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'archived'; lookup: DaemonStandaloneSessionSummary }
  | { status: 'not-found' }
  | { status: 'still-creating' }
  | { status: 'error'; error: Error };

function StandaloneSessionGate({
  sessionId,
  attachedSessionId,
  clientId,
  restartSseOnPrompt,
  historyPageSize,
  webShellProps,
}: {
  sessionId?: string;
  attachedSessionId?: string;
  clientId?: string;
  restartSseOnPrompt?: boolean;
  historyPageSize: number;
  webShellProps: WebShellProps;
}) {
  const workspace = useWorkspace();
  const [attempt, setAttempt] = useState(0);
  const [resolution, setResolution] = useState<StandaloneResolution>(() =>
    sessionId ? { status: 'loading' } : { status: 'ready' },
  );
  const [resolutionSessionId, setResolutionSessionId] = useState(sessionId);
  const resolutionGenerationRef = useRef(0);
  const t = useMemo(
    () => getTranslator(normalizeLanguage(webShellProps.language)),
    [webShellProps.language],
  );

  const standaloneSupported =
    workspace.capabilities?.features?.includes(
      STANDALONE_SESSIONS_CAPABILITY,
    ) === true;

  useEffect(() => {
    if (!standaloneSupported) return;
    const generation = resolutionGenerationRef.current + 1;
    resolutionGenerationRef.current = generation;
    setResolutionSessionId(sessionId);
    const resolveSession = async () => {
      if (!sessionId) {
        if (resolutionGenerationRef.current === generation) {
          setResolution({ status: 'ready' });
        }
        return;
      }

      if (attachedSessionId === sessionId) {
        if (resolutionGenerationRef.current === generation) {
          setResolution({ status: 'ready' });
        }
        return;
      }

      if (resolutionGenerationRef.current === generation) {
        setResolution({ status: 'loading' });
      }
      for (let index = 0; ; index += 1) {
        let lookup: DaemonStandaloneSessionLookup;
        try {
          lookup = await workspace.client.getStandaloneSession(sessionId);
        } catch (error) {
          if (resolutionGenerationRef.current !== generation) return;
          if (isStandaloneSessionNotFoundError(error)) {
            setResolution({ status: 'not-found' });
            return;
          }
          setResolution({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
          return;
        }

        if (resolutionGenerationRef.current !== generation) return;

        if (!('state' in lookup)) {
          setResolution(
            lookup.isArchived
              ? { status: 'archived', lookup }
              : { status: 'ready' },
          );
          return;
        }
        const delay = STANDALONE_LOOKUP_DELAYS_MS[index];
        if (delay === undefined) {
          setResolution({ status: 'still-creating' });
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
        if (resolutionGenerationRef.current !== generation) return;
      }
    };
    void resolveSession();
    return () => {
      if (resolutionGenerationRef.current === generation) {
        resolutionGenerationRef.current += 1;
      }
    };
  }, [
    attempt,
    attachedSessionId,
    sessionId,
    standaloneSupported,
    workspace.client,
  ]);

  const capabilities = workspace.capabilities;
  if (workspace.status === 'error') {
    return (
      <WorkspaceUnavailableState
        title={t('session.loadFailed')}
        description={t('session.capabilitiesFailed')}
        actionLabel={t('common.retry')}
        theme={webShellProps.theme}
        icon={<WifiOffIcon />}
        onAction={() => {
          void workspace.refreshCapabilities?.().catch(() => {});
        }}
      />
    );
  }
  if (!capabilities) {
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
  if (!standaloneSupported) {
    return (
      <WorkspaceUnavailableState
        title={t('session.standaloneUnavailable')}
        description={t('session.standaloneUpgradeRequired')}
        theme={webShellProps.theme}
        icon={<WifiOffIcon />}
      />
    );
  }
  if (
    (resolutionSessionId !== sessionId && attachedSessionId !== sessionId) ||
    resolution.status === 'loading'
  ) {
    return (
      <div
        data-web-shell-root
        data-web-shell-shadcn
        className={`flex min-h-32 w-full items-center justify-center gap-2 text-sm text-muted-foreground ${webShellProps.theme === 'dark' ? 'dark' : ''}`}
        role="status"
        aria-live="polite"
      >
        <Spinner />
        <span>{t('session.resolving')}</span>
      </div>
    );
  }
  if (resolution.status === 'not-found') {
    return (
      <WorkspaceUnavailableState
        title={t('session.notFound')}
        description={t('session.notFoundDescription')}
        actionLabel={
          webShellProps.onSessionIdChange ? t('session.new') : undefined
        }
        theme={webShellProps.theme}
        icon={<WifiOffIcon />}
        onAction={
          webShellProps.onSessionIdChange
            ? () => {
                webShellProps.onSessionIdChange?.(
                  undefined,
                  undefined,
                  undefined,
                  { kind: 'standalone' },
                );
              }
            : undefined
        }
      />
    );
  }
  if (resolution.status === 'error' || resolution.status === 'still-creating') {
    return (
      <WorkspaceUnavailableState
        title={t('session.loadFailed')}
        description={
          resolution.status === 'still-creating'
            ? t('session.stillCreating')
            : resolution.error.message
        }
        actionLabel={t('common.retry')}
        theme={webShellProps.theme}
        icon={<WifiOffIcon />}
        onAction={() => setAttempt((current) => current + 1)}
      />
    );
  }
  if (resolution.status === 'archived') {
    return (
      <WorkspaceUnavailableState
        title={t('session.archived')}
        description={t('session.archivedDescription')}
        actionLabel={t('session.unarchive')}
        theme={webShellProps.theme}
        onAction={() => {
          const requestedSessionId = sessionId!;
          const normalizedSessionId = requestedSessionId.toLowerCase();
          const generation = resolutionGenerationRef.current;
          void workspace.client
            .unarchiveStandaloneSessions([requestedSessionId])
            .then((result) => {
              if (resolutionGenerationRef.current !== generation) return;
              if (
                result.unarchived.includes(normalizedSessionId) ||
                result.alreadyActive.includes(normalizedSessionId)
              ) {
                setResolution({ status: 'ready' });
                return;
              }
              if (result.notFound?.includes(normalizedSessionId)) {
                setResolution({ status: 'not-found' });
                return;
              }
              const failure = result.errors.find(
                (entry) => entry.sessionId === normalizedSessionId,
              );
              throw new Error(failure?.message ?? t('session.unarchiveFailed'));
            })
            .catch((error: unknown) => {
              if (resolutionGenerationRef.current !== generation) return;
              setResolution({
                status: 'error',
                error:
                  error instanceof Error ? error : new Error(String(error)),
              });
            });
        }}
      />
    );
  }

  return (
    <DaemonSessionProvider
      key="main-session"
      sessionId={sessionId}
      sessionContext={{ kind: 'standalone' }}
      clientId={clientId}
      historyPageSize={historyPageSize}
      subagentTranscriptMode="summary"
      maxBlocks={WEB_SHELL_MAX_TRANSCRIPT_BLOCKS}
      suppressOwnUserEcho
      restartEventStreamOnPrompt={restartSseOnPrompt}
    >
      <App
        {...webShellProps}
        historyPageSize={historyPageSize}
        restartSseOnPrompt={restartSseOnPrompt}
      />
    </DaemonSessionProvider>
  );
}
