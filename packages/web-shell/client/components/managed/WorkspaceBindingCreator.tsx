import { useEffect, useRef, useState } from 'react';
import shellStyles from '../../App.module.css';
import { useI18n } from '../../i18n';
import { ChatEditor } from '../ChatEditor';
import { WelcomeHeader } from '../WelcomeHeader';
import type {
  ComposerSubmitCommit,
  EditorHandle,
} from '../../hooks/useComposerCore';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentWorkspace,
  ManagedApprovalMode,
  ManagedSessionOptions,
} from './managed-agent-provider';
import { isManagedApprovalMode } from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

interface PendingCreation {
  agentId: string;
  workspaceId: string;
  cwdRelative: string;
  input: [] | [{ type: 'input_text'; text: string }];
  clientId: string;
  idempotencyKey: string;
  sessionId?: string;
  approvalMode?: ManagedApprovalMode;
}

interface PendingWorkspace {
  displayName: string;
  idempotencyKey: string;
}

function validWorkspaceName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/\p{Cc}/u.test(value);
}

function readPendingWorkspace(key: string): PendingWorkspace | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value !== 'object' || !value) return undefined;
    const item = value as Record<string, unknown>;
    if (
      typeof item['displayName'] === 'string' &&
      item['displayName'] === item['displayName'].trim() &&
      validWorkspaceName(item['displayName']) &&
      typeof item['idempotencyKey'] === 'string' &&
      item['idempotencyKey'].length > 0 &&
      item['idempotencyKey'].length <= 128
    ) {
      return {
        displayName: item['displayName'],
        idempotencyKey: item['idempotencyKey'],
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readPending(key: string): PendingCreation | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value !== 'object' || !value) return undefined;
    const item = value as Record<string, unknown>;
    const input = item['input'];
    const first: unknown = Array.isArray(input) ? input[0] : undefined;
    if (
      typeof item['agentId'] !== 'string' ||
      typeof item['workspaceId'] !== 'string' ||
      typeof item['cwdRelative'] !== 'string' ||
      typeof item['clientId'] !== 'string' ||
      typeof item['idempotencyKey'] !== 'string' ||
      (item['approvalMode'] !== undefined &&
        !isManagedApprovalMode(item['approvalMode'])) ||
      !Array.isArray(input) ||
      input.length > 1 ||
      (input.length === 1 &&
        (typeof first !== 'object' ||
          first === null ||
          (first as Record<string, unknown>)['type'] !== 'input_text' ||
          typeof (first as Record<string, unknown>)['text'] !== 'string')) ||
      (item['sessionId'] !== undefined && typeof item['sessionId'] !== 'string')
    )
      return undefined;
    return value as PendingCreation;
  } catch {
    return undefined;
  }
}

function savePending(key: string, value?: PendingCreation): boolean {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspaceBindingCreator({
  provider,
  clientId,
  onCreated,
  onAbandoned,
  interactive = true,
}: {
  provider: ManagedAgentProvider;
  clientId: string;
  onCreated: (sessionId: string) => void;
  onAbandoned?: () => void;
  interactive?: boolean;
}) {
  const { t } = useI18n();
  const binding = provider.workspaceBinding!;
  const pendingKey = `qwen-managed-workspace-create:${provider.storageKey}`;
  const [pending, setPending] = useState(() => readPending(pendingKey));
  const pendingRef = useRef(pending);
  const workspacePendingKey = `qwen-managed-workspace-registration:${provider.storageKey}`;
  const [pendingWorkspace, setPendingWorkspace] = useState(() =>
    readPendingWorkspace(workspacePendingKey),
  );
  const pendingWorkspaceRef = useRef(pendingWorkspace);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(
    Boolean(pendingWorkspace),
  );
  const [workspaceName, setWorkspaceName] = useState(
    pendingWorkspace?.displayName ?? '',
  );
  const [workspaceCreating, setWorkspaceCreating] = useState(false);
  const workspaceCreatingRef = useRef(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [canCreateWorkspace, setCanCreateWorkspace] = useState(false);
  const [supportsApprovalModeSelection, setSupportsApprovalModeSelection] =
    useState(false);
  const [sessionOptions, setSessionOptions] = useState<
    ManagedSessionOptions & { agentId: string }
  >();
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string>();
  const [optionsRevision, setOptionsRevision] = useState(0);
  const [items, setItems] = useState<ManagedAgentWorkspace[]>([]);
  const [selected, setSelected] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [cwdRelative, setCwdRelative] = useState('.');
  const [agentId, setAgentId] = useState(binding.agentId);
  const modelPresets = binding.modelPresets ?? [];
  const availableModels = [
    ...(!modelPresets.some((item) => item.agentId === binding.agentId)
      ? [{ agentId: binding.agentId, label: t('managed.modelDefault') }]
      : []),
    ...modelPresets,
  ];
  const [nextCursor, setNextCursor] = useState<string>();
  const [supported, setSupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [pathError, setPathError] = useState<string>();
  const [switchTo, setSwitchTo] = useState<string>();
  const editor = useRef<EditorHandle | null>(null);
  const acceptedCommit = useRef<ComposerSubmitCommit | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  // Commands must survive list reloads during same-identity credential refreshes.
  const commandLifetime = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const abort = new AbortController();
    commandLifetime.current = abort;
    return () => abort.abort();
  }, [pendingKey]);

  function updatePending(value?: PendingCreation) {
    pendingRef.current = value;
    setPending(value);
    if (!savePending(pendingKey, value))
      setError(t('managed.workspaceStorageUnavailable'));
  }

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const page = await binding.list({
          clientId,
          limit: 50,
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setSupported(page.supported);
        setCanCreateWorkspace(page.canCreateWorkspace === true);
        setSupportsApprovalModeSelection(
          page.supportsApprovalModeSelection === true,
        );
        setItems([
          ...new Map(
            [
              ...page.data,
              ...(page.defaultWorkspace ? [page.defaultWorkspace] : []),
            ].map((item) => [item.workspaceId, item]),
          ).values(),
        ]);
        setNextCursor(page.nextCursor);
        const previous = selectedRef.current;
        if (previous) {
          try {
            const retained = await binding.get(previous, {
              clientId,
              signal: abort.signal,
            });
            if (abort.signal.aborted) return;
            setItems((current) => [
              ...new Map(
                [...current, retained].map((item) => [item.workspaceId, item]),
              ).values(),
            ]);
            if (!retained.canCreateSession) {
              setSelected(
                page.defaultWorkspace?.workspaceId !== previous
                  ? (page.defaultWorkspace?.workspaceId ?? '')
                  : '',
              );
              setCwdRelative('.');
            }
          } catch (failure) {
            if (abort.signal.aborted) return;
            if (
              failure instanceof JavaManagedAgentHttpError &&
              failure.status === 404
            ) {
              setItems((current) =>
                current.filter((item) => item.workspaceId !== previous),
              );
              setSelected(
                page.defaultWorkspace?.workspaceId !== previous
                  ? (page.defaultWorkspace?.workspaceId ?? '')
                  : '',
              );
              setCwdRelative('.');
            } else {
              setError(
                `${t('managed.workspaceLoadFailed')} ${message(failure)}`,
              );
            }
          }
        } else {
          setSelected(page.defaultWorkspace?.workspaceId ?? '');
        }
      } catch (failure) {
        if (abort.signal.aborted) return;
        setSupported(false);
        setCanCreateWorkspace(false);
        setSupportsApprovalModeSelection(false);
        setError(
          failure instanceof JavaManagedAgentHttpError && failure.status === 404
            ? t('managed.workspaceUnsupported')
            : failure instanceof JavaManagedAgentHttpError &&
                (failure.status === 401 || failure.status === 403)
              ? t('managed.workspacePermission')
              : `${t('managed.workspaceLoadFailed')} ${message(failure)}`,
        );
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, [binding, clientId, revision, t]);

  useEffect(() => {
    const abort = new AbortController();
    if (!supportsApprovalModeSelection) {
      setSessionOptions(undefined);
      setOptionsError(undefined);
      setOptionsLoading(false);
      return () => abort.abort();
    }
    setOptionsLoading(true);
    setOptionsError(undefined);
    void (async () => {
      try {
        if (!binding.getSessionOptions)
          throw new Error(t('managed.approvalOptionsInvalid'));
        const options = await binding.getSessionOptions(agentId, {
          clientId,
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        if (
          !isManagedApprovalMode(options.approvalMode) ||
          !Array.isArray(options.availableApprovalModes) ||
          !options.availableApprovalModes.every(isManagedApprovalMode) ||
          !options.availableApprovalModes.includes(options.approvalMode)
        ) {
          throw new Error(t('managed.approvalOptionsInvalid'));
        }
        setSessionOptions((current) => ({
          ...options,
          agentId,
          approvalMode:
            current?.agentId === agentId &&
            options.availableApprovalModes.includes(current.approvalMode)
              ? current.approvalMode
              : options.approvalMode,
        }));
      } catch (failure) {
        if (abort.signal.aborted) return;
        setSessionOptions(undefined);
        setOptionsError(
          `${t('managed.approvalOptionsLoadFailed')} ${message(failure)}`,
        );
      } finally {
        if (!abort.signal.aborted) setOptionsLoading(false);
      }
    })();
    return () => abort.abort();
  }, [
    binding,
    clientId,
    agentId,
    supportsApprovalModeSelection,
    optionsRevision,
    t,
  ]);

  const currentOptions =
    sessionOptions?.agentId === agentId ? sessionOptions : undefined;
  const approvalReady =
    !supportsApprovalModeSelection ||
    (!optionsLoading && Boolean(currentOptions));
  const displayedApprovalMode = pending
    ? pending.approvalMode
    : supportsApprovalModeSelection
      ? currentOptions?.approvalMode
      : undefined;

  async function loadMore() {
    const abort = lifetime.current;
    if (!abort || abort.signal.aborted || !nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await binding.list({
        clientId,
        cursor: nextCursor,
        limit: 50,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setSupported(page.supported);
      setCanCreateWorkspace(page.canCreateWorkspace === true);
      setSupportsApprovalModeSelection(
        page.supportsApprovalModeSelection === true,
      );
      setItems((current) => [
        ...new Map(
          [...current, ...page.data].map((item) => [item.workspaceId, item]),
        ).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch (failure) {
      if (!abort.signal.aborted) setError(message(failure));
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }

  async function createOrRead(text?: string, commit?: ComposerSubmitCommit) {
    const abort = commandLifetime.current;
    if (!abort || abort.signal.aborted || busy || workspaceCreatingRef.current)
      return;
    let attempt = pendingRef.current;
    if (
      attempt?.approvalMode !== undefined &&
      !attempt.sessionId &&
      !supportsApprovalModeSelection
    )
      return;
    const firstSubmission = !attempt;
    if (!attempt) {
      if (text !== undefined && !text.trim()) return;
      if (!approvalReady) return;
      if (
        !supported ||
        !availableModels.some((item) => item.agentId === agentId) ||
        !items.find(
          (item) => item.workspaceId === selected && item.canCreateSession,
        )
      ) {
        if (text !== undefined) setError(t('managed.workspaceChoose'));
        return;
      }
      attempt = {
        agentId,
        workspaceId: selected,
        cwdRelative,
        input: text === undefined ? [] : [{ type: 'input_text', text }],
        clientId,
        idempotencyKey: managedRequestId(),
        ...(supportsApprovalModeSelection && currentOptions
          ? { approvalMode: currentOptions.approvalMode }
          : {}),
      };
      if (!savePending(pendingKey, attempt)) {
        setError(t('managed.workspaceStorageUnavailable'));
        return;
      }
      pendingRef.current = attempt;
      setPending(attempt);
      acceptedCommit.current = commit;
    }
    setBusy(true);
    setError(undefined);
    setPathError(undefined);
    try {
      if (!attempt.sessionId) {
        const request = {
          agentId: attempt.agentId,
          workspaceId: attempt.workspaceId,
          cwdRelative: attempt.cwdRelative,
          ...(attempt.approvalMode === undefined
            ? {}
            : { approvalMode: attempt.approvalMode }),
        };
        const command = {
          clientId: attempt.clientId,
          idempotencyKey: attempt.idempotencyKey,
          signal: abort.signal,
        };
        const initial = attempt.input[0];
        if (initial && !binding.createSession)
          throw new Error(
            'The provider no longer supports initial Workspace input',
          );
        const admitted = initial
          ? await binding.createSession!(
              { ...request, text: initial.text },
              command,
            )
          : await binding.createEmpty(request, command);
        if (abort.signal.aborted) return;
        attempt = { ...attempt, sessionId: admitted.sessionId };
        updatePending(attempt);
      }
      const createdSessionId = attempt.sessionId;
      if (!createdSessionId)
        throw new Error('Create response is missing sessionId');
      const session = await provider.getSession(createdSessionId, {
        clientId: attempt.clientId,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      if (
        session.sessionId !== createdSessionId ||
        (attempt.approvalMode !== undefined &&
          session.approvalMode !== attempt.approvalMode) ||
        ((modelPresets.length > 0 || session.agentId !== undefined) &&
          session.agentId !== attempt.agentId) ||
        !session.workspace ||
        session.workspace.workspaceId !== attempt.workspaceId ||
        typeof session.workspace.cwdRelative !== 'string' ||
        !session.workspace.cwdRelative
      ) {
        throw new Error(
          t('managed.workspaceProtocolError', {
            sessionId: createdSessionId,
          }),
        );
      }
      if (attempt.input.length) {
        if (acceptedCommit.current) acceptedCommit.current();
        else editor.current?.clearText();
      }
      acceptedCommit.current = undefined;
      updatePending(undefined);
      onCreated(createdSessionId);
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (
        attempt.sessionId === undefined &&
        failure instanceof JavaManagedAgentHttpError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 408 &&
        failure.status !== 429 &&
        firstSubmission
      ) {
        updatePending(undefined);
        if (failure.code === 'unsupported_approval_mode')
          setOptionsRevision((value) => value + 1);
        if (failure.code === 'invalid_cwd') setPathError(message(failure));
        else setError(message(failure));
      } else {
        updatePending(attempt);
        setError(message(failure));
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  function choose(workspaceId: string) {
    if (!workspaceId) return;
    if (workspaceId === selected) return;
    setError(undefined);
    if (cwdRelative !== '.') setSwitchTo(workspaceId);
    else setSelected(workspaceId);
  }

  async function createWorkspace() {
    const abort = commandLifetime.current;
    if (
      !interactive ||
      !abort ||
      abort.signal.aborted ||
      !binding.createWorkspace ||
      !canCreateWorkspace ||
      busy ||
      pendingRef.current ||
      workspaceCreatingRef.current
    )
      return;
    let attempt = pendingWorkspaceRef.current;
    const firstSubmission = !attempt;
    if (!attempt) {
      const displayName = workspaceName.trim();
      if (!validWorkspaceName(displayName)) {
        setWorkspaceError(t('managed.newWorkspaceNameInvalid'));
        return;
      }
      attempt = { displayName, idempotencyKey: managedRequestId() };
      try {
        sessionStorage.setItem(workspacePendingKey, JSON.stringify(attempt));
      } catch {
        setWorkspaceError(t('managed.workspaceStorageUnavailable'));
        return;
      }
      pendingWorkspaceRef.current = attempt;
      setPendingWorkspace(attempt);
      setWorkspaceName(displayName);
    }
    workspaceCreatingRef.current = true;
    setWorkspaceCreating(true);
    setWorkspaceError(undefined);
    try {
      const created = await binding.createWorkspace(
        { displayName: attempt.displayName },
        {
          clientId,
          idempotencyKey: attempt.idempotencyKey,
          signal: abort.signal,
        },
      );
      if (abort.signal.aborted) return;
      setItems((current) => [
        ...new Map(
          [...current, created].map((item) => [item.workspaceId, item]),
        ).values(),
      ]);
      setSelected(created.workspaceId);
      setCwdRelative('.');
      pendingWorkspaceRef.current = undefined;
      setPendingWorkspace(undefined);
      try {
        sessionStorage.removeItem(workspacePendingKey);
      } catch {
        // A retained receipt only replays the same completed creation.
      }
      setWorkspaceName('');
      setWorkspaceDialogOpen(false);
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (
        firstSubmission &&
        failure instanceof JavaManagedAgentHttpError &&
        [
          'invalid_workspace_name',
          'invalid_idempotency_key',
          'workspace_creation_unavailable',
        ].includes(failure.code)
      ) {
        try {
          sessionStorage.removeItem(workspacePendingKey);
          pendingWorkspaceRef.current = undefined;
          setPendingWorkspace(undefined);
        } catch {
          // Preserve the frozen operation if local persistence cannot change.
        }
      }
      setWorkspaceError(message(failure));
    } finally {
      workspaceCreatingRef.current = false;
      if (!abort.signal.aborted) setWorkspaceCreating(false);
    }
  }

  const directInput = Boolean(binding.createSession);
  const workspaceCreationSupported = Boolean(
    canCreateWorkspace && binding.createWorkspace,
  );

  return (
    <div
      className={`${directInput ? shellStyles.appChatEmpty : ''} flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2`}
    >
      {!directInput && (
        <h2 className="text-base font-medium">
          {t('managed.workspaceCreateTitle')}
        </h2>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {directInput && pathError && (
        <p role="alert" className="text-sm text-destructive">
          {pathError}
        </p>
      )}
      {loading && <p role="status">{t('managed.loading')}</p>}
      {supportsApprovalModeSelection && optionsLoading && !pending && (
        <p role="status">{t('managed.approvalOptionsLoading')}</p>
      )}
      {supportsApprovalModeSelection && optionsError && !pending && (
        <div className="flex items-center gap-2 text-sm">
          <p role="alert" className="text-destructive">
            {optionsError}
          </p>
          <Button
            variant="outline"
            disabled={!interactive || optionsLoading}
            onClick={() => setOptionsRevision((value) => value + 1)}
          >
            {t('managed.refresh')}
          </Button>
        </div>
      )}
      {!loading && !supported && !error && (
        <p role="status">{t('managed.workspaceUnsupported')}</p>
      )}
      {!loading && supported && !items.length && !error && (
        <p role="status">{t('managed.workspaceEmpty')}</p>
      )}
      {pendingWorkspace && !workspaceDialogOpen && (
        <Button
          variant="outline"
          disabled={!interactive || busy || Boolean(pending)}
          onClick={() => setWorkspaceDialogOpen(true)}
        >
          {t('managed.newWorkspaceResume')}
        </Button>
      )}
      {pending && !busy ? (
        <div className="space-y-2 text-sm">
          <p>{t('managed.workspaceUncertain')}</p>
          <p>
            {pending.workspaceId} / {pending.cwdRelative}
          </p>
          <p>{pending.agentId}</p>
          {pending.sessionId && (
            <p>
              {t('managed.workspaceSessionId')}: {pending.sessionId}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                (!pending.sessionId &&
                  (loading ||
                    !supported ||
                    (pending.approvalMode !== undefined &&
                      !supportsApprovalModeSelection)))
              }
              onClick={() => void createOrRead()}
            >
              {pending.sessionId
                ? t('managed.workspaceRetryRead')
                : t('managed.retry')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const initial = pending.input[0];
                updatePending(undefined);
                acceptedCommit.current = undefined;
                if (initial) editor.current?.setText(initial.text);
                onAbandoned?.();
              }}
            >
              {t('managed.workspaceAbandon')}
            </Button>
          </div>
          <p className="text-muted-foreground">
            {t(
              pending.input.length > 0
                ? 'managed.workspaceAbandonInputWarning'
                : 'managed.workspaceAbandonWarning',
            )}
          </p>
        </div>
      ) : !directInput && interactive ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createOrRead();
          }}
        >
          {displayedApprovalMode && (
            <>
              <label htmlFor="managed-approval-select">
                {t('status.mode')}
              </label>
              <Select
                value={displayedApprovalMode}
                disabled={
                  busy ||
                  workspaceCreating ||
                  optionsLoading ||
                  !currentOptions ||
                  currentOptions.availableApprovalModes.length <= 1
                }
                onValueChange={(value) => {
                  if (
                    isManagedApprovalMode(value) &&
                    currentOptions?.availableApprovalModes.includes(value)
                  )
                    setSessionOptions({
                      ...currentOptions,
                      approvalMode: value,
                    });
                }}
              >
                <SelectTrigger id="managed-approval-select" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currentOptions?.availableApprovalModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`mode.label.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          {modelPresets.length > 0 && (
            <>
              <label className="block text-sm" htmlFor="managed-model-select">
                {t('managed.modelPreset')}
              </label>
              <Select
                value={agentId}
                onValueChange={setAgentId}
                disabled={busy}
              >
                <SelectTrigger id="managed-model-select" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((item) => (
                    <SelectItem key={item.agentId} value={item.agentId}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('managed.modelPinned')}
              </p>
            </>
          )}
          <label className="block text-sm" htmlFor="managed-workspace-select">
            {t('managed.workspaceLabel')}
          </label>
          <Select
            value={selected}
            onValueChange={choose}
            disabled={!supported || loading || busy}
          >
            <SelectTrigger id="managed-workspace-select" className="w-full">
              <SelectValue placeholder={t('managed.workspaceChoose')} />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem
                  key={item.workspaceId}
                  value={item.workspaceId}
                  disabled={!item.canCreateSession}
                >
                  {item.displayName} ({item.workspaceId})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {workspaceCreationSupported && (
            <Button
              type="button"
              variant="outline"
              disabled={loading || busy || workspaceCreating}
              onClick={() => setWorkspaceDialogOpen(true)}
            >
              {t('managed.newWorkspaceTitle')}
            </Button>
          )}
          {nextCursor && (
            <Button
              type="button"
              variant="ghost"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              {t('managed.more')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setRevision((n) => n + 1)}
          >
            {t('managed.refresh')}
          </Button>
          <label className="block text-sm" htmlFor="managed-workspace-cwd">
            {t('managed.workspaceDirectory')}
          </label>
          <Input
            id="managed-workspace-cwd"
            value={cwdRelative}
            onChange={(event) => {
              setCwdRelative(event.target.value);
              setPathError(undefined);
            }}
            aria-invalid={Boolean(pathError)}
            aria-describedby={
              pathError ? 'managed-workspace-path-error' : undefined
            }
            disabled={!supported || busy}
          />
          {pathError && (
            <p
              id="managed-workspace-path-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {pathError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t('managed.workspaceSharedFiles')}
          </p>
          <Button
            type="submit"
            disabled={
              !supported ||
              loading ||
              !approvalReady ||
              busy ||
              !availableModels.some((item) => item.agentId === agentId) ||
              !items.some(
                (item) =>
                  item.workspaceId === selected && item.canCreateSession,
              )
            }
          >
            {t('managed.workspaceCreate')}
          </Button>
        </form>
      ) : null}
      {directInput && (
        <div className={shellStyles.chatPane} data-managed-standard-chat>
          <div className={shellStyles.content}>
            <WelcomeHeader
              version=""
              cwd=""
              currentModel={agentId}
              currentMode=""
            />
          </div>
          <div className={shellStyles.footer}>
            <ChatEditor
              ref={editor}
              commands={[]}
              composerScopeKey={`managed:${provider.storageKey}:new`}
              disableLegacyHistoryFallback
              shellModeEnabled={false}
              workspaceFeaturesEnabled={false}
              attachmentsEnabled={false}
              visibleToolbarActions={
                interactive
                  ? [
                      ...(displayedApprovalMode
                        ? ['approvalMode' as const]
                        : []),
                      'model',
                      'workspace',
                    ]
                  : []
              }
              showChatWidthToggle={false}
              contextChipPlacement="below"
              currentModel={pending?.agentId ?? agentId}
              modelControlsDisabled={
                busy || workspaceCreating || Boolean(pending)
              }
              currentMode={displayedApprovalMode ?? ''}
              availableModes={
                pending?.approvalMode
                  ? [pending.approvalMode]
                  : currentOptions?.availableApprovalModes
              }
              modeControlsDisabled={
                busy ||
                workspaceCreating ||
                Boolean(pending) ||
                optionsLoading ||
                !currentOptions ||
                currentOptions.availableApprovalModes.length <= 1
              }
              onSelectMode={(value) => {
                if (
                  !busy &&
                  !workspaceCreating &&
                  !pendingRef.current &&
                  !optionsLoading &&
                  isManagedApprovalMode(value) &&
                  currentOptions?.availableApprovalModes.includes(value)
                ) {
                  setSessionOptions({ ...currentOptions, approvalMode: value });
                }
              }}
              availableModels={availableModels.map((item) => ({
                id: item.agentId,
                label: item.label,
              }))}
              onSelectModel={(id) => {
                if (!busy && !pendingRef.current) setAgentId(id);
              }}
              workspaces={items.map((item) => ({
                id: item.workspaceId,
                cwd: item.workspaceId,
                label: item.displayName,
                primary: false,
                trusted: item.canCreateSession,
              }))}
              selectedWorkspaceCwd={pending?.workspaceId ?? selected}
              workspaceSelectorAlwaysVisible
              scratchWorkspaceSupported={
                interactive && workspaceCreationSupported
              }
              onCreateScratchWorkspace={() => setWorkspaceDialogOpen(true)}
              workspaceMutationBusy={workspaceCreating}
              workspaceSelectionDisabled={
                !interactive ||
                !supported ||
                loading ||
                busy ||
                workspaceCreating ||
                Boolean(pending)
              }
              onSelectWorkspace={(id) => {
                if (id && !busy && !pendingRef.current) choose(id);
              }}
              composerInput={
                pending?.input[0] ? { text: pending.input[0].text } : undefined
              }
              composerInputVersion={0}
              disabled={
                !interactive ||
                busy ||
                workspaceCreating ||
                Boolean(pending) ||
                !approvalReady
              }
              dialogOpen={!interactive || workspaceDialogOpen}
              isPreparing={busy || loading || optionsLoading}
              placeholderText={t('managed.prompt')}
              onSubmit={(text, _images, _files, commit) => {
                void createOrRead(text, commit);
                return false;
              }}
            />
            <details className="mt-2 text-sm">
              <summary>
                {t('managed.workspaceDirectory')}:{' '}
                {pending?.cwdRelative ?? cwdRelative}
              </summary>
              <label htmlFor="managed-workspace-cwd">
                {t('managed.workspaceDirectory')}
              </label>
              <Input
                id="managed-workspace-cwd"
                value={pending?.cwdRelative ?? cwdRelative}
                disabled={busy || Boolean(pending)}
                aria-invalid={Boolean(pathError)}
                onChange={(event) => {
                  setCwdRelative(event.target.value);
                  setPathError(undefined);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('managed.workspaceSharedFiles')}
              </p>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setRevision((n) => n + 1)}
              >
                {t('managed.refresh')}
              </Button>
              {nextCursor && (
                <Button
                  variant="ghost"
                  disabled={loading}
                  onClick={() => void loadMore()}
                >
                  {t('managed.more')}
                </Button>
              )}
            </details>
          </div>
        </div>
      )}
      <Dialog
        open={interactive && workspaceDialogOpen}
        onOpenChange={setWorkspaceDialogOpen}
      >
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void createWorkspace();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('managed.newWorkspaceTitle')}</DialogTitle>
              <DialogDescription>
                {t('managed.newWorkspaceDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label htmlFor="managed-new-workspace-name">
                {t('managed.newWorkspaceName')}
              </label>
              <Input
                id="managed-new-workspace-name"
                value={workspaceName}
                disabled={workspaceCreating || Boolean(pendingWorkspace)}
                maxLength={128}
                autoComplete="off"
                onChange={(event) => {
                  setWorkspaceName(event.target.value);
                  setWorkspaceError(undefined);
                }}
              />
              {pendingWorkspace && !workspaceCreating && (
                <p className="text-sm text-muted-foreground">
                  {t('managed.newWorkspaceUncertain')}
                </p>
              )}
              {workspaceCreating && (
                <p role="status">{t('managed.newWorkspaceCreating')}</p>
              )}
              {workspaceError && (
                <p role="alert" className="text-sm text-destructive">
                  {workspaceError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setWorkspaceDialogOpen(false)}
              >
                {t('managed.newWorkspaceClose')}
              </Button>
              <Button
                type="submit"
                disabled={
                  loading ||
                  !workspaceCreationSupported ||
                  workspaceCreating ||
                  busy ||
                  Boolean(pending) ||
                  (!pendingWorkspace &&
                    !validWorkspaceName(workspaceName.trim()))
                }
              >
                {pendingWorkspace
                  ? t('managed.retry')
                  : t('managed.newWorkspaceCreate')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={interactive && Boolean(switchTo)}
        onOpenChange={(open) => {
          if (!open) setSwitchTo(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('managed.workspaceSwitchTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('managed.workspaceSwitchDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('managed.workspaceKeep')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (switchTo) setSelected(switchTo);
                setCwdRelative('.');
                setSwitchTo(undefined);
              }}
            >
              {t('managed.workspaceSwitch')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
