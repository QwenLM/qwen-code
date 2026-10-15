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
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

interface PendingCreation {
  agentId: string;
  workspaceId: string;
  cwdRelative: string;
  input: [] | [{ type: 'input_text'; text: string }];
  clientId: string;
  idempotencyKey: string;
  sessionId?: string;
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
}: {
  provider: ManagedAgentProvider;
  clientId: string;
  onCreated: (sessionId: string) => void;
  onAbandoned?: () => void;
}) {
  const { t } = useI18n();
  const binding = provider.workspaceBinding!;
  const pendingKey = `qwen-managed-workspace-create:${provider.storageKey}`;
  const [pending, setPending] = useState(() => readPending(pendingKey));
  const pendingRef = useRef(pending);
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
    if (!abort || abort.signal.aborted || busy) return;
    let attempt = pendingRef.current;
    const firstSubmission = !attempt;
    if (!attempt) {
      if (text !== undefined && !text.trim()) return;
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

  const directInput = Boolean(binding.createSession);

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
      {!loading && !supported && !error && (
        <p role="status">{t('managed.workspaceUnsupported')}</p>
      )}
      {!loading && supported && !items.length && !error && (
        <p role="status">{t('managed.workspaceEmpty')}</p>
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
              disabled={busy || (!pending.sessionId && (loading || !supported))}
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
      ) : !directInput ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createOrRead();
          }}
        >
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
              visibleToolbarActions={['model', 'workspace']}
              showChatWidthToggle={false}
              contextChipPlacement="below"
              currentModel={pending?.agentId ?? agentId}
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
              workspaceSelectionDisabled={
                !supported || loading || busy || Boolean(pending)
              }
              onSelectWorkspace={(id) => {
                if (id && !busy && !pendingRef.current) choose(id);
              }}
              composerInput={
                pending?.input[0] ? { text: pending.input[0].text } : undefined
              }
              composerInputVersion={0}
              disabled={busy || Boolean(pending)}
              isPreparing={busy || loading}
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
      <AlertDialog
        open={Boolean(switchTo)}
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
