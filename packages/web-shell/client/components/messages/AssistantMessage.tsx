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
import { useI18n } from '../../i18n';
import styles from './AssistantMessage.module.css';

interface AssistantMessageProps {
  content: string;
  thinking?: string;
  isStreaming?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  thinking,
  isStreaming,
}: AssistantMessageProps) {
  const { t } = useI18n();
  const compactMode = useContext(CompactModeContext);
  const { compactThinking } = useWebShellCustomization();
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  const collapsed = compactThinking && !thinkingExpanded;
  // Re-check on content growth: the clamped box stops resizing once it
  // hits 5 lines, so a ResizeObserver alone misses later overflow.
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !collapsed) return;
    setOverflowing(el.scrollHeight > el.clientHeight);
  }, [collapsed, thinking]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el || !collapsed) return;
    let animationFrame = 0;

    const check = () => {
      setOverflowing(el.scrollHeight > el.clientHeight);
    };

    const checkAfterLayout = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(check);
    };

    checkAfterLayout();

    const observer = new ResizeObserver(checkAfterLayout);
    observer.observe(el);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [collapsed]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el || !collapsed) return;
    if (isStreaming && !content) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop = 0;
    }
  }, [collapsed, isStreaming, thinking, content]);

  const handleToggle = useCallback(() => {
    setThinkingExpanded((v) => !v);
  }, []);

  return (
    <div className={styles.message}>
      {thinking && !compactMode && (
        <div className={styles.thinking}>
          <span className={styles.prefix}>✦</span>
          <div className={styles.thinkingBody}>
            {collapsed ? (
              <div
                className={
                  overflowing
                    ? `${styles.thinkingPreviewWrap} ${styles.thinkingPreviewOverflow}`
                    : styles.thinkingPreviewWrap
                }
              >
                <div
                  ref={previewRef}
                  className={`${styles.thinkingPreview} ${
                    isStreaming ? styles.thinkingPreviewTail : ''
                  }`}
                >
                  <Markdown
                    content={thinking}
                    source="thinking"
                    deferMermaid={isStreaming}
                  />
                </div>
                {overflowing && (
                  <button
                    className={styles.expandToggle}
                    onClick={handleToggle}
                    aria-expanded={false}
                    aria-label={t('thinking.expand')}
                    title={t('thinking.expand')}
                  >
                    ▼
                  </button>
                )}
              </div>
            ) : (
              <div className={styles.thinkingExpandedWrap}>
                <Markdown
                  content={thinking}
                  source="thinking"
                  deferMermaid={isStreaming}
                />
                {compactThinking && thinkingExpanded && (
                  <button
                    className={styles.expandToggle}
                    onClick={handleToggle}
                    aria-expanded={true}
                    aria-label={t('thinking.collapse')}
                    title={t('thinking.collapse')}
                  >
                    ▲
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {content && (
        <div className={styles.content}>
          <span className={styles.prefix}>✦</span>
          <div className={styles.contentBody}>
            <Markdown
              content={content}
              source="assistant"
              deferMermaid={isStreaming}
              enhanceTables
            />
          </div>
        </div>
      )}
    </div>
  );
});
