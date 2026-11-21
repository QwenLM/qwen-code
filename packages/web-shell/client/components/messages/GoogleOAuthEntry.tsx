/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../../i18n';
import styles from './AuthMessage.module.css';

export function GoogleOAuthEntry({
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
      data-dialog-initial-focus={selected ? true : undefined}
      aria-label={t('auth.google.entryTitle')}
      className={`${styles.option} ${selected ? styles.optionActive : ''}`}
      onClick={onClick}
      onFocus={onFocus}
    >
      <div className={styles.optionText}>
        <div className={styles.label}>{t('auth.google.entryTitle')}</div>
        <div className={styles.description}>
          {t('auth.google.entryDescription')}
        </div>
      </div>
    </button>
  );
}
