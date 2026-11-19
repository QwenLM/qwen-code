import {
  useDaemonAvailability,
  useDaemonAvailabilityController,
} from '../daemon/availability-context.js';
import { useI18n } from '../i18n';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';

export function DaemonConnectionBanner() {
  const state = useDaemonAvailability();
  const controller = useDaemonAvailabilityController();
  const { t } = useI18n();
  if (state === 'available') return null;
  return (
    <Alert
      className="rounded-none border-x-0 border-t-0"
      data-testid="daemon-connection-banner"
    >
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>
          {t(
            state === 'auth-required'
              ? 'daemon.connection.authRequired'
              : 'daemon.connection.paused',
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void controller?.check(true)}
        >
          {t('daemon.connection.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
