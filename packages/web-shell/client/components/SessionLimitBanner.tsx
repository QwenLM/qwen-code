import { useI18n } from '../i18n';
import { Button } from './ui/button';

export function SessionLimitBanner({
  onRelease,
  onDismiss,
}: {
  onRelease: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
      role="alert"
      data-testid="session-limit-banner"
    >
      <p>{t('session.limit.reached')}</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onRelease}>
          {t('session.limit.release')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          ×
        </Button>
      </div>
    </div>
  );
}
