/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../../i18n';
import styles from './AuthMessage.module.css';

export function QwenSubscriptionEntry({ onClick }: { onClick: () => void }) {
  const { language } = useI18n();
  return (
    <button type="button" className={styles.option} onClick={onClick}>
      <div className={styles.optionText}>
        <div className={styles.label}>
          {language === 'en'
            ? 'Qwen Account with Subscription'
            : 'Qwen 会员账号'}{' '}
          <span className={styles.newBadge}>New</span>
        </div>
        <div className={styles.description}>
          {language === 'en'
            ? 'Unlock Qwen Code + Agent with Plus/Pro Plan at chat.qwen.ai'
            : '在 chat.qwen.ai 订阅 Plus/Pro 套餐，解锁 Qwen Code + Agent'}
        </div>
      </div>
    </button>
  );
}
