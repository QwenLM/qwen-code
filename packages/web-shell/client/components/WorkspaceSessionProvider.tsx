import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WifiOffIcon } from 'lucide-react';
import {
  DaemonSessionProvider,
  useConnection,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonConnectionState } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { App, type WebShellProps } from '../App';
import {
  WEB_SHELL_HISTORY_PAGE_SIZE,
  WEB_SHELL_MAX_TRANSCRIPT_BLOCKS,
} from '../constants/sessions';
import { getTranslator, normalizeLanguage } from '../i18n';
import { Spinner } from './ui/spinner';
import { WorkspaceUnavailableState } from './WorkspaceUnavailableState';
const CLIENT_IDENTITY_FEATURE = 'client_identity';
type CommittedSessionTarget = { sessionId: string; workspaceCwd?: string };
function SessionStateObserver({
  onChange,
}: {
  onChange: (connection: DaemonConnectionState) => void;
}) {
  const connection = useConnection();
  useEffect(() => onChange(connection), [connection, onChange]);
  return null;
}

interface WorkspaceSessionProviderProps {
  sessionId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  lockWorkspaceCwd?: string;
  clientId?: string;
  restartSseOnPrompt?: boolean;
  historyPageSize?: number;
  webShellProps: WebShellProps;
}

export function WorkspaceSessionProvider({
  sessionId,
  workspaceId,
  workspaceCwd,
  lockWorkspaceCwd,
  clientId,
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
    [sessionId, lockWorkspaceCwd, workspaceCwd, workspaceId],
  );
  const effectiveSessionId = usePrimaryNewSession ? undefined : sessionId;
  const effectiveWorkspaceCwd = usePrimaryNewSession
    ? undefined
    : (lockWorkspaceCwd ?? workspaceCwd);
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
  const desiredWorkspace =
    targetWorkspace ??
    (!effectiveWorkspaceCwd && !effectiveWorkspaceId
      ? workspace.capabilities?.workspaces?.find(
          (entry) =>
            entry.primary || entry.cwd === workspace.capabilities?.workspaceCwd,
        )
      : undefined);
  const t = useMemo(
    () => getTranslator(normalizeLanguage(webShellProps.language)),
    [webShellProps.language],
  );
  const onSessionIdChange = webShellProps.onSessionIdChange;
  const transactionalRef = useRef<boolean | undefined>(undefined);
  if (workspace.capabilities) {
    transactionalRef.current = workspace.capabilities.features.includes(
      CLIENT_IDENTITY_FEATURE,
    );
  }
  const transactional = transactionalRef.current === true;
  const desiredKey = `${effectiveSessionId ?? ''}\0${effectiveWorkspaceCwd ?? effectiveWorkspaceId ?? ''}`;
  const [, setCommittedTarget] = useState<CommittedSessionTarget>();
  const committedTargetRef = useRef<CommittedSessionTarget | undefined>(
    undefined,
  );
  const pendingHostCommitKeyRef = useRef<string | undefined>(undefined);
  if (
    pendingHostCommitKeyRef.current !== undefined &&
    pendingHostCommitKeyRef.current !== desiredKey
  ) {
    pendingHostCommitKeyRef.current = undefined;
  }
  const installCommittedTarget = useCallback(
    (target: CommittedSessionTarget) => {
      committedTargetRef.current = target;
      setCommittedTarget(target);
    },
    [],
  );
  const commitTarget = useCallback(
    (target: CommittedSessionTarget) => {
      pendingHostCommitKeyRef.current =
        target.sessionId !== effectiveSessionId ||
        target.workspaceCwd !== desiredWorkspace?.cwd
          ? desiredKey
          : undefined;
      installCommittedTarget(target);
    },
    [
      desiredKey,
      desiredWorkspace?.cwd,
      effectiveSessionId,
      installCommittedTarget,
    ],
  );
  const canKeepCommitted =
    transactional && committedTargetRef.current !== undefined;
  const desiredTargetResolved =
    (!effectiveWorkspaceCwd && !effectiveWorkspaceId) ||
    targetWorkspace !== undefined;
  const failureLatchRef = useRef<string | undefined>(undefined);
  const desiredTargetFailed =
    workspace.status === 'error' ||
    (!desiredTargetResolved &&
      ((lockWorkspaceCwd !== undefined &&
        registrationErrorCwd === lockWorkspaceCwd) ||
        (workspace.capabilities !== undefined && !lockWorkspaceCwd)));
  const desiredTargetReady = desiredTargetResolved && !desiredTargetFailed;
  const controlledTargetUncommitted =
    effectiveSessionId !== undefined &&
    pendingHostCommitKeyRef.current !== desiredKey &&
    (effectiveSessionId !== committedTargetRef.current?.sessionId ||
      desiredWorkspace?.cwd !== committedTargetRef.current?.workspaceCwd);
  const desiredTargetPending =
    canKeepCommitted &&
    failureLatchRef.current !== desiredKey &&
    !desiredTargetFailed &&
    (!desiredTargetReady || controlledTargetUncommitted);
  const reportCommittedTarget = useCallback(() => {
    const committed = committedTargetRef.current;
    if (!committed) return;
    const workspaceId = workspace.capabilities?.workspaces?.find(
      (entry) => entry.cwd === committed.workspaceCwd,
    )?.id;
    onSessionIdChange?.(
      committed.sessionId,
      workspaceId,
      committed.workspaceCwd,
    );
  }, [onSessionIdChange, workspace.capabilities?.workspaces]);
  const observeSessionState = useCallback(
    (connection: DaemonConnectionState) => {
      if (
        transactional &&
        connection.status === 'connected' &&
        connection.sessionId
      ) {
        installCommittedTarget({
          sessionId: connection.sessionId,
          workspaceCwd: connection.workspaceCwd,
        });
      }
      const transition = connection.sessionTransition;
      if (
        transition?.phase === 'failed' &&
        transition.targetSessionId === effectiveSessionId &&
        transition.targetWorkspaceCwd === desiredWorkspace?.cwd &&
        failureLatchRef.current !== desiredKey
      ) {
        failureLatchRef.current = desiredKey;
        reportCommittedTarget();
      }
    },
    [
      desiredKey,
      effectiveSessionId,
      installCommittedTarget,
      reportCommittedTarget,
      desiredWorkspace?.cwd,
      transactional,
    ],
  );

  useEffect(() => {
    if (!canKeepCommitted || desiredTargetReady) {
      if (failureLatchRef.current !== desiredKey) {
        failureLatchRef.current = undefined;
      }
      return;
    }
    if (!desiredTargetFailed || failureLatchRef.current === desiredKey) return;
    failureLatchRef.current = desiredKey;
    reportCommittedTarget();
  }, [
    canKeepCommitted,
    desiredKey,
    desiredTargetFailed,
    desiredTargetReady,
    reportCommittedTarget,
  ]);
  const keepCommittedTarget =
    canKeepCommitted &&
    (!desiredTargetReady || pendingHostCommitKeyRef.current === desiredKey);
  const providerSessionId = keepCommittedTarget
    ? committedTargetRef.current!.sessionId
    : effectiveSessionId;
  const providerWorkspaceCwd = keepCommittedTarget
    ? committedTargetRef.current!.workspaceCwd
    : desiredWorkspace?.cwd;
  const visibleWorkspaceCwd = canKeepCommitted
    ? committedTargetRef.current!.workspaceCwd
    : desiredWorkspace?.cwd;
  const visibleWorkspace =
    (desiredWorkspace?.cwd === visibleWorkspaceCwd
      ? desiredWorkspace
      : undefined) ??
    workspace.capabilities?.workspaces?.find(
      (entry) => entry.cwd === visibleWorkspaceCwd,
    ) ??
    (registeredLockedWorkspace?.cwd === visibleWorkspaceCwd
      ? registeredLockedWorkspace
      : undefined);

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
    workspace.status === 'error' &&
    !canKeepCommitted
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
    !workspace.capabilities &&
    !canKeepCommitted
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
  if (
    lockWorkspaceCwd &&
    registrationErrorCwd === lockWorkspaceCwd &&
    !canKeepCommitted
  ) {
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
  if (lockWorkspaceCwd && !targetWorkspace && !canKeepCommitted) {
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
  if (
    (effectiveWorkspaceCwd || effectiveWorkspaceId) &&
    !targetWorkspace &&
    !canKeepCommitted
  ) {
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
      key={
        transactionalRef.current !== false
          ? 'transactional-main-session'
          : `${targetWorkspace?.id ?? effectiveWorkspaceId ?? 'primary'}:${effectiveSessionId ?? 'new'}`
      }
      sessionId={providerSessionId}
      workspaceCwd={providerWorkspaceCwd}
      clientId={clientId}
      historyPageSize={historyPageSize}
      subagentTranscriptMode="summary"
      maxBlocks={WEB_SHELL_MAX_TRANSCRIPT_BLOCKS}
      suppressOwnUserEcho
      restartEventStreamOnPrompt={restartSseOnPrompt}
      onSessionTransitionCommit={commitTarget}
    >
      <SessionStateObserver onChange={observeSessionState} />
      <App
        {...webShellProps}
        desiredSessionTargetPending={desiredTargetPending}
        historyPageSize={historyPageSize}
        restartSseOnPrompt={restartSseOnPrompt}
        initialSelectedWorkspaceCwd={
          !lockWorkspaceCwd ? visibleWorkspaceCwd : undefined
        }
        lockedWorkspaceCwd={lockWorkspaceCwd ? visibleWorkspaceCwd : undefined}
        lockedWorkspaceCapability={
          lockWorkspaceCwd ? visibleWorkspace : undefined
        }
      />
    </DaemonSessionProvider>
  );
}
