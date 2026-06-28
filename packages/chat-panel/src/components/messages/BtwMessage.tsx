import { memo } from 'react';
import { useI18n } from '../../i18n.js';
import { Markdown } from '../../markdown.js';
import styles from './BtwMessage.module.css';

interface BtwMessageProps {
  question: string;
  answer: string;
  isPending: boolean;
}

function BtwMessageComponent({ question, answer, isPending }: BtwMessageProps) {
  const { t } = useI18n();

  return (
    <div className={styles.message}>
      <div className={styles.content}>
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
      </div>
      <div className={styles.shortcuts}>
        {isPending ? t('btw.shortcuts.pending') : t('btw.shortcuts.done')}
      </div>
    </div>
  );
}

export const BtwMessage = memo(BtwMessageComponent);
