import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useI18n } from '../../i18n';
import { Markdown } from './Markdown';
import styles from './BtwMessage.module.css';

interface BtwMessageProps {
  question: string;
  answer: string;
  isPending: boolean;
  /** Task explanations are button-triggered, not a typed /btw command. */
  hidePrefix?: boolean;
  /** The detail-panel mirror has no focusable surface of its own, so the
   * composer panel's key hints would advertise keys that act on whatever
   * control holds focus (Enter on the header "?" re-asks). */
  hideShortcuts?: boolean;
}

export const BtwMessage = memo(function BtwMessage({
  question,
  answer,
  isPending,
  hidePrefix = false,
  hideShortcuts = false,
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
          {!hidePrefix && <span className={styles.prefix}>/btw </span>}
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
      {!hideShortcuts && (
        <div className={styles.shortcuts}>
          {isPending ? t('btw.shortcuts.pending') : t('btw.shortcuts.done')}
        </div>
      )}
    </div>
  );
});
