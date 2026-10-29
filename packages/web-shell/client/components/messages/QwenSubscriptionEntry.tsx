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
}: {
  selected: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-label={t('subscription.entryTitle')}
      className={`${styles.option} ${selected ? styles.optionActive : ''}`}
      onClick={onClick}
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
