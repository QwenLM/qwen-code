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
  const compactMode = useContext(CompactModeContext);
  const { compactThinking } = useWebShellCustomization();
  const { t } = useI18n();
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  const collapsed = compactThinking && !thinkingExpanded;
  // While thinking is still streaming (no content yet), the collapsed
  // preview follows the tail so the latest thought stays visible.
  const streamingTail = collapsed && !!isStreaming && !content;

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
    // Tail mode pins the newest line into view; when streaming ends the
    // same element switches back to line-clamp, which needs scrollTop 0.
    el.scrollTop = streamingTail ? el.scrollHeight : 0;
  }, [collapsed, streamingTail, thinking]);

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
              <div className={styles.thinkingPreviewWrap}>
                <div
                  ref={previewRef}
                  className={
                    streamingTail
                      ? styles.thinkingPreviewTail
                      : styles.thinkingPreview
                  }
                >
                  {thinking}
                </div>
                {overflowing && (
                  <button
                    className={styles.expandToggle}
                    onClick={handleToggle}
                    aria-expanded={false}
                    aria-label={t('assistant.toggleThinking')}
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
                    aria-label={t('assistant.toggleThinking')}
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
            />
          </div>
        </div>
      )}
    </div>
  );
});
