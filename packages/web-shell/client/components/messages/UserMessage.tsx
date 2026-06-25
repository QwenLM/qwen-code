import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isSafeImageSrc } from './Markdown';
import { useI18n } from '../../i18n';
import styles from './UserMessage.module.css';

interface UserMessageImage {
  data: string;
  mimeType: string;
}

interface UserMessageProps {
  content: string;
  images?: UserMessageImage[];
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
}: UserMessageProps) {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  const measureOverflow = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > 400);
  }, []);

  useLayoutEffect(() => {
    setExpanded(false);
    measureOverflow();
  }, [content, images?.length, measureOverflow]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureOverflow]);

  return (
    <div className={styles.chatMessageRow}>
      <div className={styles.chatBubble}>
        <div
          ref={contentRef}
          className={`${styles.chatContent} ${
            overflowing && !expanded ? styles.chatContentCollapsed : ''
          }`}
        >
          {images && images.length > 0 && (
            <div className={styles.chatImages}>
              {images.map((img, index) => {
                const src = img.data.startsWith('data:')
                  ? img.data
                  : `data:${img.mimeType};base64,${img.data}`;
                if (!isSafeImageSrc(src)) return null;
                return (
                  <img
                    key={index}
                    src={src}
                    alt={`User uploaded image ${index + 1}`}
                    className={styles.chatImageThumb}
                    onLoad={measureOverflow}
                  />
                );
              })}
            </div>
          )}
          {content}
        </div>
        {overflowing && (
          <button
            type="button"
            className={styles.toggleButton}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>
              {expanded ? t('userMessage.showLess') : t('userMessage.showMore')}
            </span>
            <svg
              className={`${styles.toggleIcon} ${
                expanded ? styles.toggleIconExpanded : ''
              }`}
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                d="m4 6 4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});
