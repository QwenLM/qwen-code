import { EllipsisVerticalIcon, MoreHorizontalIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { DialogShell } from '../dialogs/DialogShell';
import sidebarStyles from '../sidebar/WebShellSidebar.module.css';
import type {
  ManagedAgentSessionSummary,
  ManagedLifecycleAction,
} from './managed-agent-provider';
import type { ManagedLifecycleState } from './use-managed-session-lifecycle';

export function managedSessionActions(
  session: ManagedAgentSessionSummary,
): ManagedLifecycleAction[] {
  const caps = session.capabilities;
  switch (session.lifecycleStatus) {
    case 'active':
      return [
        ...(caps.sessionClose ? ['close' as const] : []),
        ...(caps.sessionClose ? ['close_archive' as const] : []),
        ...(caps.sessionDelete ? ['delete' as const] : []),
      ];
    case 'closed':
      return [
        ...(caps.sessionArchive ? ['archive' as const] : []),
        ...(caps.sessionDelete ? ['delete' as const] : []),
      ];
    case 'archived':
      return [
        ...(caps.sessionUnarchive ? ['unarchive' as const] : []),
        ...(caps.sessionDelete ? ['delete' as const] : []),
      ];
    default:
      return [];
  }
}

export function ManagedSessionActions({
  session,
  sidebar = false,
  lifecycle,
  exporting,
  state,
  onAction,
  onExport,
  onConfirm,
  onRename,
}: {
  session: ManagedAgentSessionSummary;
  sidebar?: boolean;
  lifecycle: boolean;
  exporting?: boolean;
  state?: ManagedLifecycleState;
  onAction: (
    session: ManagedAgentSessionSummary,
    action: ManagedLifecycleAction,
  ) => void;
  onExport?: (sessionId: string, format: 'html' | 'md') => void;
  onConfirm: (sessionId: string) => void;
  onRename?: () => void;
}) {
  const { t } = useI18n();
  const actions = lifecycle ? managedSessionActions(session) : [];
  const canManage = Object.entries(session.capabilities).some(
    ([key, value]) => key.startsWith('session') && value === true,
  );
  if (!actions.length && !onExport && !state && !onRename) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {sidebar ? (
          <button
            type="button"
            className={sidebarStyles.sessionActionButton}
            aria-label={`${t('managed.sessionActions')}: ${session.title}`}
            title={t('sidebar.moreActions')}
          >
            <EllipsisVerticalIcon aria-hidden="true" />
          </button>
        ) : (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`${t('managed.sessionActions')}: ${session.title}`}
          >
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={onExport ? 'w-72 max-w-[calc(100vw-1rem)]' : undefined}
      >
        {onRename && (
          <DropdownMenuItem
            disabled={Boolean(state?.canConfirm || state?.busy)}
            onSelect={onRename}
          >
            {t('sidebar.rename')}
          </DropdownMenuItem>
        )}
        {exporting && (
          <DropdownMenuItem disabled>{t('managed.exporting')}</DropdownMenuItem>
        )}
        {state && (
          <DropdownMenuItem disabled>
            {t(`managed.lifecycle.${state.status}`)}
          </DropdownMenuItem>
        )}
        {state?.canConfirm &&
          !state.busy &&
          (canManage || state.status !== 'failed') && (
            <DropdownMenuItem onSelect={() => onConfirm(session.sessionId)}>
              {t(
                state.status === 'failed'
                  ? 'managed.lifecycle.retry'
                  : 'managed.lifecycle.confirm',
              )}
            </DropdownMenuItem>
          )}
        {actions.map((action) => (
          <DropdownMenuItem
            key={action}
            disabled={Boolean(state?.canConfirm || state?.busy)}
            onSelect={() => onAction(session, action)}
          >
            {t(`managed.lifecycle.${action}`)}
          </DropdownMenuItem>
        ))}
        {onExport && (
          <>
            <DropdownMenuItem
              className="flex-col items-start gap-0.5 whitespace-normal"
              disabled={exporting}
              onSelect={() => onExport(session.sessionId, 'html')}
            >
              <span>{t('managed.exportHtml')}</span>
              <span className="text-xs leading-snug text-muted-foreground">
                {t('managed.exportHtmlDescription')}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="flex-col items-start gap-0.5 whitespace-normal"
              disabled={exporting}
              onSelect={() => onExport(session.sessionId, 'md')}
            >
              <span>{t('managed.exportMarkdown')}</span>
              <span className="text-xs leading-snug text-muted-foreground">
                {t('managed.exportMarkdownDescription')}
              </span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ManagedLifecycleConfirmation({
  session,
  action,
  onConfirm,
  onClose,
}: {
  session: ManagedAgentSessionSummary;
  action: ManagedLifecycleAction;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <DialogShell
      title={t(`managed.lifecycle.${action}`)}
      size="sm"
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="break-words font-medium">{session.title}</p>
        <p>
          {t(
            action === 'delete'
              ? 'managed.lifecycle.deleteDescription'
              : 'managed.lifecycle.closeDescription',
          )}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={action === 'delete' ? 'destructive' : 'default'}
            onClick={onConfirm}
          >
            {t(`managed.lifecycle.${action}`)}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
