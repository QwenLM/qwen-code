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
  const previewRef = useRef<HTMLDivElement>(null);
  const thinkingExpandedRef = useRef(thinkingExpanded);

  const collapsed = compactThinking && !thinkingExpanded;
  thinkingExpandedRef.current = thinkingExpanded;

  useEffect(() => {
    const el = previewRef.current;
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
            {collapsed ? (
              <div className={styles.thinkingPreviewWrap}>
                <div ref={previewRef} className={styles.thinkingPreview}>
                  {thinking}
                </div>
                {compactThinking && overflowing && (
                  <button
                    className={styles.expandToggle}
                    onClick={handleToggle}
                    aria-expanded={false}
                    aria-label="Toggle thinking details"
                  >
                    ▼
                  </button>
                )}
              </div>
            ) : (
              <div className={styles.thinkingExpandedWrap}>
                <Markdown content={thinking} source="thinking" />
                {compactThinking && thinkingExpanded && (
                  <button
                    className={styles.expandToggle}
                    onClick={handleToggle}
                    aria-expanded={true}
                    aria-label="Toggle thinking details"
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
            <Markdown content={content} source="assistant" />
          </div>
        </div>
      )}
    </div>
  );
});
