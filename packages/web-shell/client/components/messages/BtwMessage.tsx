import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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
  const contentRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const followAnswer = useCallback(() => {
    const content = contentRef.current;
    if (content && following.current) content.scrollTop = content.scrollHeight;
  }, []);

  useLayoutEffect(followAnswer, [answer, isPending, followAnswer]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(followAnswer);
    if (contentRef.current) observer.observe(contentRef.current);
    if (answerRef.current) observer.observe(answerRef.current);
    return () => observer.disconnect();
  }, [followAnswer]);

  return (
    <div className={styles.message}>
      <div
        ref={contentRef}
        className={styles.content}
        data-web-shell-btw-content
        onScroll={(event) => {
          const content = event.currentTarget;
          following.current =
            content.scrollHeight - content.clientHeight - content.scrollTop <=
            2;
        }}
      >
        <div className={styles.question}>
          <span className={styles.prefix}>/btw </span>
          <span>{question}</span>
        </div>
        <div ref={answerRef} className={styles.answer}>
          {isPending && !answer ? (
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
});
