import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import type { ReactNode } from 'react';

/**
 * The folder step before it can show folders: the daemon's capabilities are
 * still loading, the lookup failed, or the daemon cannot register workspaces at
 * all. One shell for all three, so the states cannot overlap or leave a gap.
 */
export function WorkspaceAddStatusDialog({
  message,
  tone,
  subtitle,
  onClose,
  children,
}: {
  message: string;
  tone: 'status' | 'alert';
  subtitle?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
      subtitle={subtitle}
      size="md"
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        {children}
        <p role={tone}>{message}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('sidebar.addWorkspaceCancel')}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
