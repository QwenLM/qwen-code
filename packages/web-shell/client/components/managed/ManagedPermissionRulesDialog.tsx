import { useId, useState } from 'react';
import { parseManagedPermissionRules } from '@qwen-code/qwen-code-core/managed-runtime/managed-permission-rules.js';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import type { ManagedPermissionRules } from './managed-agent-provider';
import { managedPermissionRulesEqual } from './managed-agent-provider';

const KINDS = ['allow', 'ask', 'deny'] as const;

export function ManagedPermissionRulesDialog({
  rules,
  revision,
  disabled,
  busy,
  errorCode,
  onSave,
}: {
  rules?: ManagedPermissionRules;
  revision: number;
  disabled: boolean;
  busy: boolean;
  errorCode?: string;
  onSave: (rules: ManagedPermissionRules) => Promise<boolean | undefined>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState(revision);
  const [draft, setDraft] = useState({ allow: '', ask: '', deny: '' });
  const reset = () => {
    setDraft({
      allow: rules?.allow.join('\n') ?? '',
      ask: rules?.ask.join('\n') ?? '',
      deny: rules?.deny.join('\n') ?? '',
    });
    setBasis(revision);
  };
  let parsed: ManagedPermissionRules | undefined;
  try {
    parsed = parseManagedPermissionRules(
      Object.fromEntries(
        KINDS.map((kind) => [
          kind,
          draft[kind]
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean),
        ]),
      ),
    );
  } catch {
    // The form displays the portable grammar before any request is persisted.
  }
  const stale = basis !== revision;
  const canSave =
    !disabled &&
    !busy &&
    !stale &&
    parsed !== undefined &&
    !managedPermissionRulesEqual(parsed, rules);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) reset();
        setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          {t('managed.permissionRules.title')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('managed.permissionRules.title')}</DialogTitle>
          <DialogDescription>
            {t('managed.permissionRules.description')}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave || !parsed) return;
            void onSave(parsed).then((saved) => {
              if (saved) setOpen(false);
            });
          }}
          className="space-y-3"
        >
          <p className="text-sm text-muted-foreground" id={`${id}-syntax`}>
            {t('managed.permissionRules.syntax')}
          </p>
          {KINDS.map((kind) => (
            <div key={kind} className="space-y-1">
              <label htmlFor={`${id}-${kind}`} className="text-sm font-medium">
                {t(`managed.permissionRules.${kind}`)}
              </label>
              <Textarea
                id={`${id}-${kind}`}
                value={draft[kind]}
                rows={3}
                aria-describedby={`${id}-syntax`}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, [kind]: event.target.value })
                }
                className="font-mono text-sm"
              />
            </div>
          ))}
          {!parsed && (
            <p role="alert" className="text-sm text-destructive">
              {t('managed.permissionRules.invalid')}
            </p>
          )}
          {stale && (
            <div role="alert" className="text-sm text-destructive">
              {t('managed.approvalChange.conflict')}
              <Button type="button" variant="ghost" size="sm" onClick={reset}>
                {t('managed.approvalChange.reload')}
              </Button>
            </div>
          )}
          {errorCode && (
            <p role="alert" className="text-sm text-destructive">
              {t(
                errorCode === 'unconfirmed'
                  ? 'managed.approvalChange.unconfirmed'
                  : errorCode === 'approval_selection_conflict'
                    ? 'managed.approvalChange.conflict'
                    : 'managed.approvalChange.failed',
              )}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft({ allow: '', ask: '', deny: '' })}
            >
              {t('managed.permissionRules.clear')}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {t(
                busy
                  ? 'managed.approvalChange.changing'
                  : 'managed.permissionRules.save',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
