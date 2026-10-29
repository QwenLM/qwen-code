import { useI18n } from '../../i18n';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';

export type QwenSubscriptionState =
  | { status: 'waiting'; authorizationUrl: string }
  | {
      status: 'purchase-required';
      email: string;
      plan: 'Free' | 'Go';
      checking?: boolean;
      canCheckAgain?: boolean;
      message?: string;
    }
  | { status: 'ready'; email: string; plan: 'Plus' | 'Pro' }
  | { status: 'query-error'; message: string; checking?: boolean }
  | { status: 'error'; message: string; retry?: 'authorization' };

interface QwenSubscriptionStatusProps {
  state: QwenSubscriptionState;
  onOpenAuthorization: (url: string) => void;
  onOpenPurchase: () => void;
  onRetry: () => void;
  onSwitchProvider: () => void;
  onSignOut: () => void;
  onCancel: () => void;
}

export function QwenSubscriptionStatus({
  state,
  onOpenAuthorization,
  onOpenPurchase,
  onRetry,
  onSwitchProvider,
  onSignOut,
  onCancel,
}: QwenSubscriptionStatusProps) {
  const { t } = useI18n();
  if (state.status === 'ready') {
    return (
      <div role="status">
        <p>{t('subscription.signedIn', { email: state.email })}</p>
        <p>{t('subscription.ready', { plan: state.plan })}</p>
      </div>
    );
  }
  return (
    <section
      aria-label={t('subscription.title')}
      className="flex flex-col gap-3"
    >
      {state.status === 'purchase-required' && (
        <p>
          {t('subscription.signedInWithPlan', {
            email: state.email,
            plan: state.plan,
          })}
        </p>
      )}
      <Alert
        variant={
          state.status === 'error' || state.status === 'query-error'
            ? 'destructive'
            : 'default'
        }
        role={
          state.status === 'error' || state.status === 'query-error'
            ? 'alert'
            : 'status'
        }
      >
        <AlertTitle>
          {t(
            state.status === 'purchase-required'
              ? 'subscription.included'
              : 'subscription.title',
          )}
        </AlertTitle>
        <AlertDescription>
          {state.status === 'error' || state.status === 'query-error' ? (
            state.status === 'query-error' && state.checking ? (
              t('subscription.checking')
            ) : (
              state.message
            )
          ) : state.status === 'waiting' ? (
            t('subscription.waiting')
          ) : (
            <div className="flex flex-col gap-2">
              <p>{t('subscription.purchase-required', { plan: state.plan })}</p>
              <p>
                {state.checking
                  ? t('subscription.checking')
                  : (state.message ?? t('subscription.waitingForPurchase'))}
              </p>
            </div>
          )}
        </AlertDescription>
      </Alert>
      {state.status === 'waiting' && state.authorizationUrl && (
        <div className="flex flex-col items-start gap-2">
          <p>{t('subscription.browserFallback')}</p>
          <Button
            type="button"
            variant="link"
            className="h-auto max-w-full whitespace-normal break-all text-left"
            aria-label={t('subscription.openAuthorization')}
            onClick={() => onOpenAuthorization(state.authorizationUrl)}
          >
            {state.authorizationUrl}
          </Button>
          <p>{t('subscription.pending')}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {state.status === 'purchase-required' && (
          <>
            {state.canCheckAgain && (
              <Button type="button" onClick={onRetry} disabled={state.checking}>
                {t('subscription.checkAgain')}
              </Button>
            )}
            <Button type="button" onClick={onOpenPurchase}>
              {t('subscription.openPlans')}
            </Button>
            <Button type="button" variant="outline" onClick={onSwitchProvider}>
              {t('subscription.switchProvider')}
            </Button>
            <Button type="button" variant="outline" onClick={onSignOut}>
              {t('subscription.signOut')}
            </Button>
          </>
        )}
        {(state.status === 'query-error' ||
          (state.status === 'error' && state.retry === 'authorization')) && (
          <Button
            type="button"
            onClick={onRetry}
            disabled={state.status === 'query-error' && state.checking}
          >
            {t(
              state.status === 'query-error'
                ? 'subscription.checkAgain'
                : 'subscription.signInAgain',
            )}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('subscription.cancel')}
        </Button>
      </div>
    </section>
  );
}
