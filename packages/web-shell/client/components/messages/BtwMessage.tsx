import { memo } from 'react';
import { useI18n } from '../../i18n';
import { Markdown } from './Markdown';
import styles from './BtwMessage.module.css';

interface BtwMessageProps {
  question: string;
  answer: string;
  isPending: boolean;
}

export const BtwMessage = memo(function BtwMessage({
  question,
  answer,
  isPending,
}: BtwMessageProps) {
  const { t } = useI18n();

  return (
    <div className={styles.message}>
      <div className={styles.question}>
        <span className={styles.prefix}>/btw </span>
        <span>{question}</span>
      </div>
      <div className={styles.answer}>
        {isPending ? (
          <span className={styles.pending}>{t('btw.answering')}</span>
        ) : (
          <Markdown content={answer} />
        )}
      </div>
      <div className={styles.shortcuts}>
        {isPending ? t('btw.shortcuts.pending') : t('btw.shortcuts.done')}
      </div>
    </div>
  );
});
