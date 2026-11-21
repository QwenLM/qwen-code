import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
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
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Spinner } from '../ui/spinner';
import type {
  ManagedAgentProvider,
  ManagedSessionWorktree,
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';
import {
  useManagedWorktreeReason,
  useManagedWorktreeText,
} from './managed-worktree-messages';

export function ManagedWorktreeStatus({
  worktree,
  compact = false,
}: {
  worktree: ManagedSessionWorktree;
  compact?: boolean;
}) {
  const text = useManagedWorktreeText();
  const reason = useManagedWorktreeReason();
  const progressing = ['preparing', 'removing'].includes(worktree.state);
  return (
    <div className="space-y-1 text-sm" data-managed-worktree={worktree.state}>
      <div className="flex items-center gap-2" role="status">
        {progressing && <Spinner className="size-3" aria-hidden="true" />}
        <Badge variant="secondary">
          {text(worktree.state === 'blocked' ? 'blockedState' : worktree.state)}
        </Badge>
      </div>
      {!compact && (
        <>
          <p className="break-all">
            {text('branch')}: {worktree.branch}
          </p>
          <p className="text-muted-foreground">
            {text('baseCommit')}: {worktree.baseCommit.slice(0, 12)}
          </p>
        </>
      )}
      {worktree.errorCode && (
        <p className="text-destructive">{reason(worktree.errorCode)}</p>
      )}
    </div>
  );
}

type Inspection = Awaited<
  ReturnType<NonNullable<ManagedAgentProvider['sessionWorktrees']>['inspect']>
>;

export function ManagedSessionWorktrees({
  provider,
  clientId,
  workspaceId,
  open,
  onOpenChange,
}: {
  provider: Pick<ManagedAgentProvider, 'storageKey' | 'sessionWorktrees'>;
  clientId: string;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const text = useManagedWorktreeText();
  const reason = useManagedWorktreeReason();
  const api = provider.sessionWorktrees;
  const [items, setItems] = useState<ManagedSessionWorktree[]>();
  const [selected, setSelected] = useState<string>();
  const [inspection, setInspection] = useState<Inspection>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const command = useRef<{ id: string; key: string } | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const selectedRevision = items?.find(
    (item) => item.id === selected,
  )?.revision;

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setItems(undefined);
    setSelected(undefined);
    setInspection(undefined);
    setError(undefined);
    setBusy(false);
    setConfirm(false);
    command.current = undefined;
    return () => abort.abort();
  }, [provider.storageKey, clientId, workspaceId, open]);

  useEffect(() => {
    if (!open || !api) return;
    const abort = new AbortController();
    setError(undefined);
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setLoading(true);
      try {
        const result = await api!.list(workspaceId, {
          clientId,
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setItems(result.data);
        if (
          result.data.some((item) =>
            ['preparing', 'removing'].includes(item.state),
          )
        )
          timer = setTimeout(() => void load(), 2000);
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, clientId, workspaceId, open, revision]);

  useEffect(() => {
    setInspection(undefined);
    if (!open || !api || !selected) return;
    const abort = new AbortController();
    void api
      .inspect(workspaceId, selected, { clientId, signal: abort.signal })
      .then(
        (value) => {
          if (!abort.signal.aborted) setInspection(value);
        },
        (failure: unknown) => {
          if (!abort.signal.aborted)
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
        },
      );
    return () => abort.abort();
  }, [api, clientId, workspaceId, open, selected, selectedRevision, revision]);

  async function cleanup() {
    const abort = lifetime.current;
    if (
      !api ||
      !inspection?.canCleanup ||
      !abort ||
      abort.signal.aborted ||
      busy
    )
      return;
    const id = inspection.worktree.id;
    if (command.current?.id !== id)
      command.current = { id, key: managedRequestId() };
    setBusy(true);
    setError(undefined);
    try {
      await api.cleanup(workspaceId, id, {
        clientId,
        idempotencyKey: command.current.key,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      command.current = undefined;
      setInspection(undefined);
      setConfirm(false);
      setRevision((value) => value + 1);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) onOpenChange(value);
        }}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{text('manage')}</DialogTitle>
            <DialogDescription>{text('retained')}</DialogDescription>
          </DialogHeader>
          <p className="break-all">{workspaceId}</p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {loading && !items && <p role="status">{t('managed.loading')}</p>}
          {items?.length === 0 && <p>{text('empty')}</p>}
          <div className="space-y-3">
            {items?.map((item) => (
              <div key={item.id} className="space-y-2 rounded-md border p-3">
                <p className="break-all">
                  {text('session')}: {item.sessionId}
                </p>
                <p className="break-all">{item.cwdRelative}</p>
                <ManagedWorktreeStatus
                  worktree={
                    inspection?.worktree.id === item.id
                      ? inspection.worktree
                      : item
                  }
                />
                {item.state !== 'removed' && (
                  <Button
                    variant="outline"
                    disabled={busy || (selected === item.id && !inspection)}
                    onClick={() => {
                      setSelected(item.id);
                      setRevision((value) => value + 1);
                    }}
                  >
                    {text('inspect')}
                  </Button>
                )}
                {inspection?.worktree.id === item.id &&
                  (inspection.canCleanup ? (
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setConfirm(true)}
                    >
                      {text('cleanup')}
                    </Button>
                  ) : inspection.cleanupBlocker ? (
                    <p role="status" className="text-muted-foreground">
                      {text('blocked')}: {reason(inspection.cleanupBlocker)}
                    </p>
                  ) : null)}
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            disabled={loading || busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('managed.refresh')}
          </Button>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirm}
        onOpenChange={(value) => {
          if (!busy) setConfirm(value);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{text('confirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {text('confirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all text-sm">
            {inspection?.worktree.cwdRelative}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !inspection?.canCleanup}
              onClick={(event) => {
                event.preventDefault();
                void cleanup();
              }}
            >
              {text('cleanup')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
