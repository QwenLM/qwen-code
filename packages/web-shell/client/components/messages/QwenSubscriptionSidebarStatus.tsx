import { getTranslator, useI18n } from '../../i18n';
import { Button } from '../ui/button';
import {
  QwenSubscriptionStatus,
  type QwenSubscriptionStatusProps,
} from './QwenSubscriptionStatus';
import styles from './QwenSubscriptionSidebarStatus.module.css';

const english = getTranslator('en');

export function QwenSubscriptionSidebarStatus(
  props: QwenSubscriptionStatusProps,
) {
  const {
    state,
    onOpenAuthorization,
    onOpenPurchase,
    onRetry,
    onSwitchProvider,
    onUseAnotherAccount,
    onCancel,
  } = props;
  const { t } = useI18n();
  if (state.status === 'ready') {
    return <QwenSubscriptionStatus {...props} />;
  }
  if (state.status === 'purchase-required') {
    const actions = state.canCheckAgain
      ? [
          {
            key: 'check',
            label: english('subscription.checkAgain'),
            onClick: onRetry,
            disabled: state.checking,
          },
        ]
      : [
          {
            key: 'plans',
            label: english('subscription.openPlans'),
            onClick: onOpenPurchase,
            disabled: false,
          },
          {
            key: 'provider',
            label: english('subscription.switchProvider'),
            onClick: onSwitchProvider,
            disabled: false,
          },
        ];
    actions.push({
      key: 'account',
      label: english('subscription.useAnotherAccount'),
      onClick: onUseAnotherAccount,
      disabled: false,
    });
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
            <Button
              key={action.key}
              type="button"
              variant={
                action.key === 'account'
                  ? 'link'
                  : action.key === 'plans'
                    ? 'default'
                    : 'outline'
              }
              aria-label={action.label}
              className={
                action.key === 'account' ? styles.accountAction : styles.action
              }
              onClick={action.onClick}
              disabled={action.disabled}
            >
              {action.label}
            </Button>
          ))}
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
            {t('subscription.checkAgain')}
          </Button>
        )}
        {state.status !== 'query-error' && (
          <Button
            type="button"
            variant="outline"
            className={styles.action}
            onClick={onCancel}
          >
            {t('subscription.cancel')}
          </Button>
        )}
      </div>
    </section>
  );
}
