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

function getRenderedLineCount(element: HTMLElement): number {
  const tops: number[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim()) continue;

    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width === 0 || rect.height === 0) continue;
      const top = Math.round(rect.top);
      if (!tops.some((value) => Math.abs(value - top) <= 1)) {
        tops.push(top);
      }
    }
    range.detach();
  }

  return tops.length;
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
  const contentRef = useRef<HTMLDivElement>(null);

  const collapsed = compactThinking && !thinkingExpanded;

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || !compactThinking) return;

    const check = () => {
      setOverflowing(getRenderedLineCount(contentEl) > 5);
    };

    check();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedCheck = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 150);
    };

    const observer = new ResizeObserver(debouncedCheck);
    observer.observe(contentEl);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [compactThinking, thinking]);

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
              <div ref={contentRef}>
                <Markdown
                  content={thinking}
                  source="thinking"
                  trailingInline={
                    compactThinking && thinkingExpanded ? (
                      <button
                        className={styles.expandToggle}
                        onClick={handleToggle}
                        aria-expanded={true}
                        aria-label="Collapse thinking details"
                      >
                        ▲
                      </button>
                    ) : null
                  }
                />
              </div>
              {compactThinking && collapsed && overflowing && (
                <button
                  className={styles.expandToggle}
                  onClick={handleToggle}
                  aria-expanded={false}
                  aria-label="Expand thinking details"
                >
                  ... ▼
                </button>
              )}
            </div>
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
