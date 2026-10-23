import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { DialogShell } from './DialogShell';

interface SessionRenameDialogProps {
  value: string;
  busy: boolean;
  error?: string;
  onChange: (value: string) => void;
  onSubmit: (displayName: string) => void;
  onClose: () => void;
}

export function SessionRenameDialog({
  value,
  busy,
  error,
  onChange,
  onSubmit,
  onClose,
}: SessionRenameDialogProps) {
  const { t } = useI18n();
  return (
    <DialogShell title={t('sidebar.rename')} size="sm" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const displayName = value.trim();
          if (!busy && displayName && displayName.length <= 256) {
            onSubmit(displayName);
          }
        }}
      >
        <Input
          autoFocus
          aria-label={t('sidebar.rename')}
          maxLength={256}
          value={value}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229)
            ) {
              event.preventDefault();
            }
          }}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={busy || !value.trim() || value.trim().length > 256}
          >
            {t('common.save')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
