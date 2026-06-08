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

  const collapsed = compactThinking && !thinkingExpanded;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !compactThinking) return;
    setOverflowing(el.scrollHeight > el.clientHeight);
  }, [thinking, compactThinking, thinkingExpanded]);

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
              className={collapsed ? styles.thinkingCollapsed : undefined}
            >
              <Markdown content={thinking} source="thinking" />
            </div>
            {compactThinking && (overflowing || thinkingExpanded) && (
              <button className={styles.expandToggle} onClick={handleToggle}>
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
