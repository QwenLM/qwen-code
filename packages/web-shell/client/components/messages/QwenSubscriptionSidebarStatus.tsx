import { getTranslator, useI18n } from '../../i18n';
import { Button } from '../ui/button';
import type { QwenSubscriptionStatusProps } from './QwenSubscriptionStatus';
import styles from './QwenSubscriptionSidebarStatus.module.css';

const english = getTranslator('en');

export function QwenSubscriptionSidebarStatus({
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
      <div role="status" className={`${styles.message} ${styles.success}`}>
        <p>✓ {t('subscription.signedIn', { email: state.email })}</p>
        <p>✓ {t('subscription.ready', { plan: state.plan })}</p>
      </div>
    );
  }
  if (state.status === 'purchase-required') {
    const actions = [
      ...(state.canCheckAgain
        ? [
            {
              key: 'check',
              label: 'Check again',
              description: '',
              onClick: onRetry,
              disabled: state.checking,
            },
          ]
        : []),
      {
        key: 'plans',
        label: 'Open plans again',
        description: 'Opens the Qwen Code plans page in your browser',
        onClick: onOpenPurchase,
      },
      {
        key: 'provider',
        label: 'Use Alibaba ModelStudio instead',
        description: 'Coding Plan, Token Plan, or Standard API Key',
        onClick: onSwitchProvider,
      },
      {
        key: 'signout',
        label: 'Sign out',
        description: 'Disconnect this device from your Qwen account',
        onClick: onSignOut,
      },
    ];
    return (
      <section
        aria-label={english('subscription.title')}
        lang="en"
        className={styles.content}
      >
        <p className={styles.success}>
          ✓{' '}
          {english('subscription.signedInWithPlan', {
            email: state.email,
            plan: state.plan,
          })}
        </p>
        <div role="status" className={styles.message}>
          <p className={styles.title}>{english('subscription.included')}</p>
          <p>
            {english('subscription.purchase-required', { plan: state.plan })}
          </p>
          <p
            role={state.message && !state.checking ? 'alert' : undefined}
            className={state.message && !state.checking ? styles.error : ''}
          >
            {state.checking
              ? english('subscription.checking')
              : (state.message ?? english('subscription.waitingForPurchase'))}
          </p>
        </div>
        <div className={styles.actions}>
          {actions.map((action) => (
            <div key={action.key} className={styles.actionGroup}>
              <Button
                type="button"
                variant={action.key === 'plans' ? 'default' : 'outline'}
                aria-label={action.label}
                className={styles.action}
                onClick={action.onClick}
                disabled={action.disabled}
              >
                {action.label}
              </Button>
              {action.description && (
                <p className={styles.description}>{action.description}</p>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            className={styles.action}
            onClick={onCancel}
          >
            {t('subscription.cancel')}
          </Button>
        </div>
      </section>
    );
  }
  const failed =
    state.status === 'error' ||
    (state.status === 'query-error' && !state.checking);
  return (
    <section aria-label={t('subscription.title')} className={styles.content}>
      <div
        className={failed ? styles.error : ''}
        role={failed ? 'alert' : 'status'}
      >
        {state.status === 'waiting'
          ? t('subscription.waiting')
          : state.status === 'query-error' && state.checking
            ? t('subscription.checking')
            : state.message}
      </div>
      {state.status === 'waiting' && state.authorizationUrl && (
        <div className={styles.linkGroup}>
          <p className={styles.muted}>{t('subscription.browserFallback')}</p>
          <Button
            type="button"
            variant="link"
            className={styles.link}
            aria-label={t('subscription.openAuthorization')}
            onClick={() => onOpenAuthorization(state.authorizationUrl)}
          >
            {state.authorizationUrl}
          </Button>
        </div>
      )}
      {state.status === 'waiting' && <p>{t('subscription.pending')}</p>}
      <div className={styles.actions}>
        {(state.status === 'query-error' ||
          (state.status === 'error' && state.retry === 'authorization')) && (
          <Button
            type="button"
            className={styles.action}
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
        <Button
          type="button"
          variant="outline"
          className={styles.action}
          onClick={onCancel}
        >
          {t('subscription.cancel')}
        </Button>
      </div>
    </section>
  );
}
