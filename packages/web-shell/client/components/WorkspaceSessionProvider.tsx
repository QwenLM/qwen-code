import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { WifiOffIcon } from 'lucide-react';
import {
  DaemonSessionProvider,
  useConnection,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
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
  lockWorkspaceCwd?: string;
  clientId?: string;
  restartSseOnPrompt?: boolean;
  historyPageSize?: number;
  webShellProps: WebShellProps;
}

function SessionCommitObserver({
  desiredSessionId,
  desiredWorkspace,
  desiredWorkspaceRequired,
  desiredClientId,
  onCommit,
  onFailure,
  children,
}: {
  desiredSessionId?: string;
  desiredWorkspace?: DaemonWorkspaceCapability;
  desiredWorkspaceRequired: boolean;
  desiredClientId?: string;
  onCommit: () => void;
  onFailure: () => void;
  children: (desiredCommitted: boolean) => ReactNode;
}) {
  const connection = useConnection();
  const reportedFailureRef = useRef<
    typeof connection.sessionTransition | undefined
  >(undefined);
  const desiredCommitted =
    connection.sessionId === desiredSessionId &&
    (!desiredWorkspaceRequired || desiredWorkspace !== undefined) &&
    (!desiredWorkspace || connection.workspaceCwd === desiredWorkspace.cwd) &&
    (!desiredClientId || connection.clientId === desiredClientId) &&
    !connection.sessionTransition;
  useEffect(() => {
    if (desiredCommitted) onCommit();
  }, [desiredCommitted, onCommit]);
  useEffect(() => {
    const transition = connection.sessionTransition;
    if (
      transition?.phase !== 'failed' ||
      transition === reportedFailureRef.current ||
      transition.targetSessionId !== desiredSessionId ||
      (desiredWorkspace &&
        transition.targetWorkspaceCwd !== desiredWorkspace.cwd) ||
      (desiredClientId && transition.targetClientId !== desiredClientId)
    ) {
      return;
    }
    reportedFailureRef.current = transition;
    onFailure();
  }, [
    connection.sessionTransition,
    desiredClientId,
    desiredSessionId,
    desiredWorkspace,
    onFailure,
  ]);
  return children(desiredCommitted);
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
  const implicitPrimaryWorkspace = useMemo(
    () =>
      workspace.capabilities?.workspaces?.find((entry) => entry.primary) ??
      (workspace.capabilities?.workspaceCwd
        ? {
            id: 'primary',
            cwd: workspace.capabilities.workspaceCwd,
            primary: true,
            trusted: true,
          }
        : undefined),
    [workspace.capabilities?.workspaceCwd, workspace.capabilities?.workspaces],
  );
  const targetWorkspace = effectiveWorkspaceCwd
    ? (pathWorkspace ?? registeredLockedWorkspace)
    : effectiveWorkspaceId
      ? workspace.capabilities?.workspaces?.find(
          (entry) => entry.id === effectiveWorkspaceId,
        )
      : implicitPrimaryWorkspace;
  const [committedTarget, setCommittedTarget] = useState<{
    sessionId?: string;
    workspace?: DaemonWorkspaceCapability;
    clientId?: string;
  }>();
  useEffect(() => {
    if (!committedTarget && targetWorkspace) {
      setCommittedTarget({
        sessionId: effectiveSessionId,
        workspace: targetWorkspace,
        ...(clientId ? { clientId } : {}),
      });
    }
  }, [clientId, committedTarget, effectiveSessionId, targetWorkspace]);
  const hasCommittedTarget = committedTarget?.workspace !== undefined;
  const hasExplicitWorkspaceTarget = Boolean(
    effectiveWorkspaceCwd || effectiveWorkspaceId,
  );
  const t = useMemo(
    () => getTranslator(normalizeLanguage(webShellProps.language)),
    [webShellProps.language],
  );
  const providerWorkspace = targetWorkspace ?? committedTarget?.workspace;
  const providerSessionId = targetWorkspace
    ? effectiveSessionId
    : hasExplicitWorkspaceTarget
      ? committedTarget?.sessionId
      : effectiveSessionId;
  const providerClientId = targetWorkspace
    ? clientId
    : hasExplicitWorkspaceTarget
      ? committedTarget?.clientId
      : clientId;
  const appWorkspace = committedTarget?.workspace ?? providerWorkspace;
  const commitDesiredTarget = useCallback(() => {
    if (!targetWorkspace) return;
    setFailedTransitionTargetKey(undefined);
    setCommittedTarget({
      sessionId: effectiveSessionId,
      workspace: targetWorkspace,
      ...(clientId ? { clientId } : {}),
    });
  }, [clientId, effectiveSessionId, targetWorkspace]);
  const notifyCommittedTarget = useCallback(() => {
    const committedWorkspace = committedTarget?.workspace;
    if (!committedWorkspace) return;
    webShellProps.onSessionIdChange?.(
      committedTarget.sessionId,
      committedWorkspace.primary ? undefined : committedWorkspace.id,
      committedWorkspace.cwd,
    );
  }, [committedTarget, webShellProps]);
  const desiredTargetKey = JSON.stringify([
    effectiveSessionId,
    targetWorkspace?.cwd ??
      effectiveWorkspaceCwd ??
      (effectiveWorkspaceId ? `id:${effectiveWorkspaceId}` : undefined),
    clientId,
  ]);
  const committedTargetKey = JSON.stringify([
    committedTarget?.sessionId,
    committedTarget?.workspace?.cwd,
    committedTarget?.clientId,
  ]);
  const [failedDesiredTargetKey, setFailedDesiredTargetKey] =
    useState<string>();
  const [failedTransitionTargetKey, setFailedTransitionTargetKey] =
    useState<string>();
  useEffect(() => {
    setFailedTransitionTargetKey((failedKey) =>
      failedKey === undefined || failedKey === desiredTargetKey
        ? failedKey
        : undefined,
    );
  }, [desiredTargetKey]);
  const failDesiredTransition = useCallback(() => {
    setFailedTransitionTargetKey(desiredTargetKey);
    notifyCommittedTarget();
  }, [desiredTargetKey, notifyCommittedTarget]);

  useEffect(() => {
    if (targetWorkspace) {
      if (failedDesiredTargetKey === desiredTargetKey) {
        setFailedDesiredTargetKey(undefined);
      }
      return;
    }
    if (!hasCommittedTarget) return;
    const targetFailed =
      workspace.status === 'error' ||
      (lockWorkspaceCwd !== undefined &&
        registrationErrorCwd === lockWorkspaceCwd) ||
      (!lockWorkspaceCwd &&
        workspace.capabilities !== undefined &&
        Boolean(effectiveWorkspaceCwd || effectiveWorkspaceId));
    if (!targetFailed || failedDesiredTargetKey === desiredTargetKey) {
      return;
    }
    setFailedDesiredTargetKey(desiredTargetKey);
    notifyCommittedTarget();
  }, [
    desiredTargetKey,
    effectiveWorkspaceCwd,
    effectiveWorkspaceId,
    failedDesiredTargetKey,
    hasCommittedTarget,
    lockWorkspaceCwd,
    notifyCommittedTarget,
    registrationErrorCwd,
    targetWorkspace,
    workspace.capabilities,
    workspace.status,
  ]);
  const desiredTargetPending =
    hasCommittedTarget &&
    desiredTargetKey !== committedTargetKey &&
    failedDesiredTargetKey !== desiredTargetKey &&
    failedTransitionTargetKey !== desiredTargetKey;

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
    !hasCommittedTarget
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
    !hasCommittedTarget
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
    !hasCommittedTarget
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
  if (lockWorkspaceCwd && !targetWorkspace && !hasCommittedTarget) {
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
    !hasCommittedTarget
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
      sessionId={providerSessionId}
      workspaceCwd={providerWorkspace?.cwd}
      clientId={providerClientId}
      historyPageSize={historyPageSize}
      subagentTranscriptMode="summary"
      maxBlocks={WEB_SHELL_MAX_TRANSCRIPT_BLOCKS}
      suppressOwnUserEcho
      restartEventStreamOnPrompt={restartSseOnPrompt}
    >
      <SessionCommitObserver
        desiredSessionId={effectiveSessionId}
        desiredWorkspace={targetWorkspace}
        desiredWorkspaceRequired={hasExplicitWorkspaceTarget}
        desiredClientId={clientId}
        onCommit={commitDesiredTarget}
        onFailure={failDesiredTransition}
      >
        {(desiredCommitted) => {
          const visibleAppWorkspace =
            desiredCommitted && targetWorkspace
              ? targetWorkspace
              : appWorkspace;
          return (
            <App
              {...webShellProps}
              desiredTargetPending={desiredTargetPending && !desiredCommitted}
              historyPageSize={historyPageSize}
              restartSseOnPrompt={restartSseOnPrompt}
              initialSelectedWorkspaceCwd={
                !lockWorkspaceCwd && visibleAppWorkspace
                  ? visibleAppWorkspace.cwd
                  : undefined
              }
              lockedWorkspaceCwd={
                lockWorkspaceCwd ? visibleAppWorkspace?.cwd : undefined
              }
              lockedWorkspaceCapability={
                lockWorkspaceCwd ? visibleAppWorkspace : undefined
              }
            />
          );
        }}
      </SessionCommitObserver>
    </DaemonSessionProvider>
  );
}
