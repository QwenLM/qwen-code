import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
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
  ManagedRuntimeNode,
  ManagedWorkspaceDirectory,
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

interface RegistrationIntent {
  nodeId: string;
  path: string;
  displayName: string;
  idempotencyKey: string;
  operationId?: string;
}

function readIntent(key: string): RegistrationIntent | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return undefined;
    const item = value as Record<string, unknown>;
    if (
      ['nodeId', 'path', 'displayName', 'idempotencyKey'].some(
        (name) => typeof item[name] !== 'string' || !item[name],
      ) ||
      (item['operationId'] !== undefined &&
        (typeof item['operationId'] !== 'string' || !item['operationId']))
    )
      return undefined;
    return value as RegistrationIntent;
  } catch {
    return undefined;
  }
}

function persist(key: string, intent?: RegistrationIntent): boolean {
  try {
    if (intent) sessionStorage.setItem(key, JSON.stringify(intent));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, 1_000);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

export function RemoteWorkspaceRegistration({
  provider,
  clientId,
  open,
  onOpenChange,
  onAvailable,
  onRegistered,
}: {
  provider: ManagedAgentProvider;
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAvailable: (available: boolean) => void;
  onRegistered: (workspace: ManagedAgentWorkspace) => void;
}) {
  const { t } = useI18n();
  const key = `qwen-managed-ssh-workspace-registration:${provider.storageKey}`;
  const [pending, setPending] = useState(() => readIntent(key));
  const pendingRef = useRef(pending);
  const [nodes, setNodes] = useState<ManagedRuntimeNode[]>([]);
  const [nodeId, setNodeId] = useState(pending?.nodeId ?? '');
  const [path, setPath] = useState(pending?.path ?? '');
  const [displayName, setDisplayName] = useState(pending?.displayName ?? '');
  const [checked, setChecked] = useState<ManagedWorkspaceDirectory>();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const current = useRef({ provider, onOpenChange, onAvailable, onRegistered });
  current.current = { provider, onOpenChange, onAvailable, onRegistered };
  const registration = provider.workspaceBinding?.registration;

  function updatePending(intent?: RegistrationIntent) {
    pendingRef.current = intent;
    setPending(intent);
    if (!persist(key, intent))
      setError(t('managed.workspaceStorageUnavailable'));
  }

  async function confirm(intent: RegistrationIntent) {
    const owner = lifetime.current;
    const binding = current.current.provider.workspaceBinding;
    const api = binding?.registration;
    if (!owner || owner.signal.aborted || running.current || !api) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    const abort = new AbortController();
    const stop = () => abort.abort();
    owner.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 30_000);
    try {
      const options = { clientId, signal: abort.signal };
      let operation = intent.operationId
        ? await api.query(intent.operationId, options)
        : await api.create(
            {
              nodeId: intent.nodeId,
              path: intent.path,
              displayName: intent.displayName,
            },
            { ...options, idempotencyKey: intent.idempotencyKey },
          );
      while (true) {
        if (owner.signal.aborted) return;
        abort.signal.throwIfAborted();
        if (
          operation.type !== 'workspace_create' ||
          !operation.operationId ||
          (intent.operationId && operation.operationId !== intent.operationId)
        )
          throw new Error('Workspace operation identity mismatch');
        if (!intent.operationId) {
          intent = { ...intent, operationId: operation.operationId };
          updatePending(intent);
        }
        if (operation.status === 'completed') {
          if (!operation.workspaceId)
            throw new Error('Workspace operation is missing its Workspace');
          const workspace = await binding!.get(operation.workspaceId, options);
          if (owner.signal.aborted) return;
          abort.signal.throwIfAborted();
          if (
            workspace.workspaceId !== operation.workspaceId ||
            !workspace.canCreateSession ||
            workspace.state !== 'active'
          ) {
            setError(t('managed.remoteWorkspacePermission'));
            return;
          }
          updatePending();
          setBlocked(false);
          current.current.onRegistered(workspace);
          current.current.onOpenChange(false);
          return;
        }
        if (operation.status === 'failed' || operation.status === 'cancelled') {
          updatePending();
          setBlocked(false);
          setChecked(undefined);
          setError(t('managed.remoteWorkspaceFailed'));
          return;
        }
        if (operation.status === 'recovery_blocked') {
          setChecked(undefined);
          setBlocked(true);
          setError(t('managed.remoteWorkspaceBlocked'));
          return;
        }
        if (operation.status !== 'pending' && operation.status !== 'running')
          throw new Error(t('managed.remoteWorkspaceUnconfirmed'));
        await pause(abort.signal);
        abort.signal.throwIfAborted();
        operation = await api.query(intent.operationId!, options);
      }
    } catch (failure) {
      if (!owner.signal.aborted) {
        updatePending(intent);
        setError(
          failure instanceof JavaManagedAgentHttpError &&
            (failure.status === 401 || failure.status === 403)
            ? t('managed.remoteWorkspacePermission')
            : t('managed.remoteWorkspaceUnconfirmed'),
        );
      }
    } finally {
      clearTimeout(timer);
      owner.signal.removeEventListener('abort', stop);
      abort.abort();
      if (!owner.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    running.current = false;
    if (pendingRef.current) {
      current.current.onOpenChange(true);
      if (pendingRef.current.operationId) void confirm(pendingRef.current);
    }
    return () => abort.abort();
    // The parent keys this component by the provider's tenant/actor storage scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The server settles a blocked registration on its own once it reads the
  // machine again, so a saved registration is queried each time the dialog
  // opens; a confirmation already running absorbs the mount's own opening.
  useEffect(() => {
    if (open && pendingRef.current?.operationId)
      void confirm(pendingRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const abort = new AbortController();
    setNodes([]);
    if (registration) {
      void registration
        .listNodes({ clientId, signal: abort.signal })
        .then((page) => {
          if (abort.signal.aborted) return;
          const available = page.supported ? page.data : [];
          setNodes(available);
        })
        .catch(() => {
          if (!abort.signal.aborted) setNodes([]);
        });
    }
    return () => abort.abort();
  }, [registration, clientId]);

  useEffect(() => {
    current.current.onAvailable(nodes.length > 0 || Boolean(pending));
  }, [nodes, pending]);

  async function checkDirectory() {
    const abort = lifetime.current;
    const api = current.current.provider.workspaceBinding?.registration;
    if (!abort || !api || running.current || pendingRef.current) return;
    running.current = true;
    setBusy(true);
    setChecked(undefined);
    setError(undefined);
    try {
      const result = await api.checkDirectory(
        { nodeId, path },
        { clientId, signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      if (result.nodeId !== nodeId || !result.canonicalPath)
        throw new Error('Workspace directory identity mismatch');
      setChecked(result);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(
          failure instanceof JavaManagedAgentHttpError &&
            (failure.status === 401 || failure.status === 403)
            ? t('managed.remoteWorkspacePermission')
            : t('managed.remoteWorkspaceInvalidDirectory'),
        );
    } finally {
      if (!abort.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  function create() {
    if (
      running.current ||
      pendingRef.current ||
      !checked ||
      checked.nodeId !== nodeId ||
      !displayName.trim() ||
      !nodes.some((node) => node.nodeId === nodeId)
    )
      return;
    const intent = {
      nodeId,
      path: checked.canonicalPath,
      displayName: displayName.trim(),
      idempotencyKey: managedRequestId(),
    };
    if (!persist(key, intent)) {
      setError(t('managed.workspaceStorageUnavailable'));
      return;
    }
    updatePending(intent);
    void confirm(intent);
  }

  function discardBlocked() {
    if (!blocked || running.current) return;
    if (!persist(key)) {
      setError(t('managed.workspaceStorageUnavailable'));
      return;
    }
    pendingRef.current = undefined;
    setPending(undefined);
    setBlocked(false);
    setChecked(undefined);
    setError(undefined);
  }

  const frozen = busy || Boolean(pending);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t('managed.remoteWorkspaceAdd')}</DialogTitle>
          <DialogDescription>
            {t('managed.remoteWorkspaceDescription')}
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="managed-runtime-node">
          {t('managed.remoteWorkspaceMachine')}
        </label>
        <Select
          value={nodeId}
          disabled={frozen}
          onValueChange={(value) => {
            setNodeId(value);
            setChecked(undefined);
            setError(undefined);
          }}
        >
          <SelectTrigger id="managed-runtime-node" className="w-full">
            <SelectValue
              placeholder={t('managed.remoteWorkspaceChooseMachine')}
            />
          </SelectTrigger>
          <SelectContent>
            {nodes.map((node) => (
              <SelectItem key={node.nodeId} value={node.nodeId}>
                {node.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label htmlFor="managed-runtime-directory">
          {t('managed.remoteWorkspaceDirectory')}
        </label>
        <Input
          id="managed-runtime-directory"
          value={path}
          disabled={frozen}
          onChange={(event) => {
            setPath(event.target.value);
            setChecked(undefined);
            setError(undefined);
          }}
        />
        <label htmlFor="managed-runtime-name">
          {t('managed.remoteWorkspaceName')}
        </label>
        <Input
          id="managed-runtime-name"
          value={displayName}
          disabled={frozen}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        {checked && <p role="status">{checked.canonicalPath}</p>}
        {busy && <p role="status">{t('managed.remoteWorkspaceWorking')}</p>}
        {pending && !blocked && (
          <p>{t('managed.remoteWorkspaceUnconfirmed')}</p>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('managed.remoteWorkspaceClose')}
          </Button>
          {blocked && pending ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={discardBlocked}
              >
                {t('managed.remoteWorkspaceStartAnother')}
              </Button>
              <Button disabled={busy} onClick={() => void confirm(pending)}>
                {t('managed.remoteWorkspaceConfirm')}
              </Button>
            </>
          ) : pending ? (
            <Button disabled={busy} onClick={() => void confirm(pending)}>
              {t('managed.remoteWorkspaceConfirm')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !path.trim() ||
                  !nodes.some((node) => node.nodeId === nodeId)
                }
                onClick={() => void checkDirectory()}
              >
                {t('managed.remoteWorkspaceCheck')}
              </Button>
              <Button
                disabled={busy || !checked || !displayName.trim()}
                onClick={create}
              >
                {t('managed.remoteWorkspaceRegister')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
