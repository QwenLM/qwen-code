/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import styles from './AuthMessage.module.css';
import { useI18n } from '../../i18n';

export function QwenSubscriptionEntry({
  selected,
  onClick,
  onFocus,
}: {
  selected: boolean;
  onClick: () => void;
  onFocus: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-web-shell-auth-option
      aria-label={t('subscription.entryTitle')}
      className={`${styles.option} ${selected ? styles.optionActive : ''}`}
      onClick={onClick}
      onFocus={onFocus}
    >
      <div className={styles.optionText}>
        <div className={styles.label}>
          {t('subscription.entryTitle')}{' '}
          <span className={styles.newBadge}>{t('subscription.new')}</span>
        </div>
        <div className={styles.description}>
          {t('subscription.entryDescription')}
        </div>
      </div>
    </button>
  );
}
