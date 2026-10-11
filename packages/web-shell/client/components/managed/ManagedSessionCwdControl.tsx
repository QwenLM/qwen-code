import { useId, useRef, useState } from 'react';
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
import type { ManagedAgentSessionSummary } from './managed-agent-provider';
import type { useManagedCwdChange } from './use-managed-cwd-change';

function errorKey(code: string) {
  switch (code) {
    case 'invalid_cwd':
      return 'managed.cwd.invalid';
    case 'session_context_busy':
      return 'managed.cwd.busy';
    case 'context_revision_conflict':
      return 'managed.cwd.conflict';
    case 'workspace_unavailable':
      return 'managed.cwd.unavailable';
    case 'session_operation_forbidden':
    case 'actor_required':
    case 'actor_scope_mismatch':
      return 'managed.cwd.forbidden';
    case 'storage_unavailable':
      return 'managed.cwd.storage';
    case 'unconfirmed':
      return 'managed.cwd.unconfirmed';
    case 'unconfirmed_forbidden':
      return 'managed.cwd.unconfirmedForbidden';
    default:
      return 'managed.cwd.failed';
  }
}

export function ManagedSessionCwdControl({
  summary,
  supported,
  cwd,
  disabledReason,
  onSubmit,
}: {
  summary: ManagedAgentSessionSummary;
  supported: boolean;
  cwd: ReturnType<typeof useManagedCwdChange>;
  disabledReason?: string;
  onSubmit: (path: string, revision: number) => Promise<boolean | void>;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const control = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [basis, setBasis] = useState<{ revision: number }>();
  const workspace = summary.workspace;
  const revision = workspace?.contextRevision;
  const capable =
    supported &&
    summary.capabilities.cwdChange === true &&
    Number.isSafeInteger(revision) &&
    (revision ?? 0) >= 1;
  if (!workspace || (!capable && !cwd.blocked && !cwd.errorCode)) return null;
  const reason = cwd.blocked
    ? t(cwd.busy ? 'managed.cwd.changing' : 'managed.cwd.unconfirmed')
    : (disabledReason ??
      (workspace.state && workspace.state !== 'ready'
        ? t('managed.cwd.unavailable')
        : undefined));
  const stale = basis !== undefined && revision !== basis.revision;
  const error = cwd.errorCode ? t(errorKey(cwd.errorCode)) : undefined;
  const status = cwd.busy ? t('managed.cwd.changing') : error;
  return (
    <div
      ref={control}
      tabIndex={-1}
      role="group"
      aria-label={t('managed.cwd.change')}
      className="flex flex-col gap-2"
      data-testid="managed-cwd-control"
    >
      {capable && (
        <div className="flex items-center gap-2">
          <Button
            ref={trigger}
            type="button"
            variant="outline"
            size="sm"
            disabled={Boolean(reason)}
            aria-describedby={reason ? `${id}-reason` : undefined}
            onClick={() => {
              setPath(
                cwd.errorCode && !cwd.blocked
                  ? (cwd.target ?? workspace.cwdRelative)
                  : workspace.cwdRelative,
              );
              setBasis({ revision: revision! });
              setOpen(true);
            }}
          >
            {t('managed.cwd.change')}
          </Button>
          {reason && (
            <span id={`${id}-reason`} className="text-sm text-muted-foreground">
              {reason}
            </span>
          )}
        </div>
      )}
      {status && (
        <p
          role={cwd.errorCode && !cwd.blocked ? 'alert' : 'status'}
          className="text-sm text-muted-foreground"
        >
          {status}
        </p>
      )}
      {cwd.blocked && !cwd.busy && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void cwd.confirm()}
        >
          {t('managed.cwd.confirm')}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current && !trigger.current.disabled)
              trigger.current.focus();
            else control.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('managed.cwd.change')}</DialogTitle>
            <DialogDescription>
              {t('managed.cwd.description')}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !basis ||
                stale ||
                !capable ||
                reason ||
                !path ||
                path === workspace.cwdRelative
              )
                return;
              void onSubmit(path, basis.revision).then((completed) => {
                if (completed) setOpen(false);
              });
            }}
          >
            <label htmlFor={`${id}-path`} className="text-sm">
              {t('managed.cwd.path')}
            </label>
            <Input
              id={`${id}-path`}
              aria-label={t('managed.cwd.path')}
              value={path}
              disabled={cwd.blocked}
              onChange={(event) => setPath(event.target.value)}
            />
            {stale && (
              <div className="my-2 text-sm" role="status">
                <p>
                  {t('managed.cwd.updated', { cwd: workspace.cwdRelative })}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!capable || Boolean(reason)}
                  onClick={() => setBasis({ revision: revision! })}
                >
                  {t('managed.cwd.useCurrent')}
                </Button>
              </div>
            )}
            {status && (
              <p role="status" className="my-2 text-sm">
                {status}
              </p>
            )}
            {cwd.blocked && !cwd.busy && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void cwd.confirm()}
              >
                {t('managed.cwd.confirm')}
              </Button>
            )}
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                {t('managed.cwd.close')}
              </Button>
              <Button
                type="submit"
                disabled={
                  !capable ||
                  Boolean(reason) ||
                  stale ||
                  !path ||
                  path === workspace.cwdRelative
                }
              >
                {t('managed.cwd.change')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
