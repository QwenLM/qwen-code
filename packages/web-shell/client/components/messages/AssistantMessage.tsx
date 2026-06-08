import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Markdown } from './Markdown';
import { CompactModeContext } from '../../App';
import { useWebShellCustomization } from '../../customization';
import styles from './AssistantMessage.module.css';

interface AssistantMessageProps {
  content: string;
  thinking?: string;
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  thinking,
}: AssistantMessageProps) {
  const compactMode = useContext(CompactModeContext);
  const { compactThinking } = useWebShellCustomization();
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const thinkingExpandedRef = useRef(thinkingExpanded);

  const collapsed = compactThinking && !thinkingExpanded;
  thinkingExpandedRef.current = thinkingExpanded;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !compactThinking) return;

    const check = () => {
      if (thinkingExpandedRef.current) return;
      setOverflowing(el.scrollHeight > el.clientHeight);
    };

    check();

    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [compactThinking]);

  const handleToggle = useCallback(() => {
    setThinkingExpanded((v) => !v);
  }, []);

  return (
    <div className={styles.message}>
      {thinking && !compactMode && (
        <div className={styles.thinking}>
          <span className={styles.prefix}>✦</span>
          <div className={styles.thinkingBody}>
            <div
              ref={bodyRef}
              className={
                collapsed
                  ? overflowing
                    ? `${styles.thinkingCollapsed} ${styles.thinkingCollapsedMask}`
                    : styles.thinkingCollapsed
                  : undefined
              }
            >
              <Markdown content={thinking} source="thinking" />
            </div>
            {compactThinking && (overflowing || thinkingExpanded) && (
              <button
                className={styles.expandToggle}
                onClick={handleToggle}
                aria-expanded={!collapsed}
                aria-label="Toggle thinking details"
              >
                {collapsed ? '···' : '▲'}
              </button>
            )}
          </div>
        </div>
      )}

      {content && (
        <div className={styles.content}>
          <span className={styles.prefix}>✦</span>
          <div className={styles.contentBody}>
            <Markdown content={content} source="assistant" />
          </div>
        </div>
      )}
    </div>
  );
});
