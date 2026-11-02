import { useState } from 'react';
import { useI18n } from '../../i18n';
import styles from './QwenSubscriptionStatus.module.css';
import authStyles from './AuthMessage.module.css';
import { Button } from '../ui/button';

export type QwenSubscriptionState =
  | { status: 'waiting'; authorizationUrl: string }
  | {
      status: 'purchase-required';
      email: string;
      plan: string;
      checking?: boolean;
      canCheckAgain?: boolean;
      message?: string;
    }
  | { status: 'ready'; email: string; plan: string }
  | { status: 'query-error'; message: string; checking?: boolean }
  | { status: 'error'; message: string; retry?: 'authorization' };

export interface QwenSubscriptionStatusProps {
  state: QwenSubscriptionState;
  onOpenAuthorization: (url: string) => void;
  onOpenPurchase: () => void;
  onRetry: () => void;
  onSwitchProvider: () => void;
  onUseAnotherAccount: () => void;
  onCancel: () => void;
}

export function QwenSubscriptionStatus({
  state,
  onOpenAuthorization,
  onOpenPurchase,
  onRetry,
  onSwitchProvider,
  onUseAnotherAccount,
  onCancel,
}: QwenSubscriptionStatusProps) {
  const { t, language } = useI18n();
  const [selectedAction, setSelectedAction] = useState('plans');
  if (state.status === 'ready') {
    return (
      <div role="status" className={`${styles.message} ${styles.success}`}>
        <p>✓ {t('subscription.signedIn', { email: state.email })}</p>
        <p>✓ {t('subscription.ready', { plan: state.plan })}</p>
      </div>
    );
  }
  if (state.status === 'purchase-required') {
    const actions = state.canCheckAgain
      ? [
          {
            key: 'check',
            label: t('subscription.checkAgain'),
            description: '',
            onClick: onRetry,
            disabled: state.checking,
          },
        ]
      : [
          {
            key: 'plans',
            label: t('subscription.openPlans'),
            description: t('subscription.openPlansDescription'),
            onClick: onOpenPurchase,
            disabled: false,
          },
          {
            key: 'provider',
            label: t('subscription.switchProvider'),
            description: t('subscription.switchProviderDescription'),
            onClick: onSwitchProvider,
            disabled: false,
          },
        ];
    return (
      <section
        aria-label={t('subscription.title')}
        lang={language}
        className={styles.content}
      >
        <div role="status" className={styles.message}>
          <p className={styles.title}>{t('subscription.included')}</p>
          <p>{t('subscription.purchase-required', { plan: state.plan })}</p>
          <p
            role={state.message && !state.checking ? 'alert' : undefined}
            className={
              state.message && !state.checking ? styles.error : styles.muted
            }
          >
            {!state.message && <span aria-hidden="true">⠂ </span>}
            {state.checking
              ? t('subscription.checking')
              : (state.message ?? t('subscription.waitingForPurchase'))}
          </p>
        </div>
        <div
          className={authStyles.options}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)',
              ),
            ];
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            buttons[
              (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
                buttons.length
            ]?.focus();
          }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              aria-label={action.label}
              data-selected={
                state.canCheckAgain || selectedAction === action.key
              }
              className={`${authStyles.option} ${state.canCheckAgain || selectedAction === action.key ? authStyles.optionActive : ''} ${styles.desktopOption}`}
              onFocus={() => setSelectedAction(action.key)}
              onMouseEnter={() => setSelectedAction(action.key)}
              onClick={action.onClick}
              disabled={action.disabled}
            >
              <span className={authStyles.optionText}>
                <span className={authStyles.label}>{action.label}</span>
                {action.description && (
                  <span className={authStyles.description}>
                    {action.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          className={styles.muted}
          onClick={onUseAnotherAccount}
        >
          {t('subscription.useAnotherAccount')}
        </Button>
      </section>
    );
  }
  return (
    <section aria-label={t('subscription.title')} className={authStyles.panel}>
      <div
        className={`${styles.message} ${
          state.status === 'error' ||
          (state.status === 'query-error' && !state.checking)
            ? authStyles.error
            : ''
        }`}
        role={
          state.status === 'error' || state.status === 'query-error'
            ? 'alert'
            : 'status'
        }
      >
        <div>
          {state.status === 'error' || state.status === 'query-error'
            ? state.status === 'query-error' && state.checking
              ? t('subscription.checking')
              : state.message
            : t('subscription.waiting')}
        </div>
      </div>
      {state.status === 'waiting' && state.authorizationUrl && (
        <div className={styles.linkGroup}>
          <p className={authStyles.muted}>
            {t('subscription.browserFallback')}
          </p>
          <button
            type="button"
            className={`${authStyles.link} ${styles.link}`}
            aria-label={t('subscription.openAuthorization')}
            onClick={() => onOpenAuthorization(state.authorizationUrl)}
          >
            {state.authorizationUrl}
          </button>
        </div>
      )}
      {state.status === 'waiting' && (
        <p className={authStyles.muted}>{t('subscription.pending')}</p>
      )}
      <div className={authStyles.actions}>
        {(state.status === 'query-error' ||
          (state.status === 'error' && state.retry === 'authorization')) && (
          <button
            type="button"
            className={`${authStyles.actionButton} self-start`}
            onClick={onRetry}
            disabled={state.status === 'query-error' && state.checking}
          >
            {t('subscription.checkAgain')}
          </button>
        )}
        {state.status !== 'query-error' && (
          <button
            type="button"
            className={authStyles.actionButton}
            onClick={onCancel}
          >
            {t('common.previous')}
          </button>
        )}
      </div>
    </section>
  );
}
