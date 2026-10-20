import styles from './MessageDeletionToolbar.module.css';
import type { MessageDeletionControls } from '../hooks/useMessageDeletion';
import { useI18n } from '../i18n';
import { Button } from './ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';

export function MessageDeletionToolbar({
  controls,
}: {
  controls: MessageDeletionControls;
}) {
  const { t } = useI18n();
  if (!controls.active && !controls.error && !controls.busy) return null;
  return (
    <>
      <div
        className={`${styles.toolbar} flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-background py-2`}
        data-web-shell-message-deletion
      >
        {controls.active && (
          <>
            <span className="mr-auto text-sm" role="status">
              {t('messageDelete.selected', {
                count: String(controls.selected.size),
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={controls.cancel}
              disabled={controls.busy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={controls.disabled || controls.selected.size === 0}
              onClick={() => controls.setConfirming(true)}
            >
              {t('messageDelete.delete')}
            </Button>
          </>
        )}
        {!controls.active && controls.error && (
          <Button variant="outline" size="sm" onClick={controls.cancel}>
            {t('common.cancel')}
          </Button>
        )}
        {controls.error && (
          <span role="alert" className="w-full text-sm text-destructive">
            {controls.error}
          </span>
        )}
        {controls.busy && (
          <span role="status" className="text-sm text-muted-foreground">
            {t('messageDelete.processing')}
          </span>
        )}
      </div>
      <AlertDialog
        open={controls.confirming}
        onOpenChange={controls.setConfirming}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('messageDelete.confirmTitle', {
                count: String(controls.selected.size),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('messageDelete.confirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={controls.busy}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={controls.disabled || controls.selected.size === 0}
              onClick={(event) => {
                event.preventDefault();
                controls.submit();
              }}
            >
              {t('messageDelete.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
