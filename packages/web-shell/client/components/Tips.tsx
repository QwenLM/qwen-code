import { useMemo } from 'react';
import { useI18n } from '../i18n';
import styles from './Tips.module.css';

function pickTip(tips: string[]): string {
  return tips[Math.floor(Math.random() * tips.length)] ?? '';
}

export function Tips() {
  const { t } = useI18n();
  const tips = useMemo(() => t('tips.items').split('|'), [t]);
  const tip = useMemo(() => pickTip(tips), [tips]);

  return (
    <div className={styles.line}>
      <span className={styles.label}>{t('welcome.tipLabel')}</span>
      <span className={styles.text}>{tip}</span>
    </div>
  );
}
