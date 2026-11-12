import { useLayoutEffect, useState, type RefObject } from 'react';

export function useChatNavigationVisible(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) {
      setVisible(false);
      return;
    }
    const container = element.closest('[data-history-viewport]') ?? element;
    let observedContent: HTMLElement | null = null;
    let resize: ResizeObserver | null = null;
    const update = () => {
      const style = getComputedStyle(element);
      const content = element.querySelector<HTMLElement>(
        '[data-web-shell-message-row]',
      );
      if (content !== observedContent) {
        if (observedContent) resize?.unobserve(observedContent);
        observedContent = content;
        if (content) resize?.observe(content);
      }
      const containerRect = container.getBoundingClientRect();
      const contentRect = content?.getBoundingClientRect();
      // Reserve rail space and keep at least 480px for transcript text.
      setVisible(
        style.getPropertyValue('--chat-content-width').trim() !== '100%' &&
          contentRect !== undefined &&
          contentRect.width >= 480 &&
          contentRect.left - containerRect.left >= 56 &&
          containerRect.right - contentRect.right >= 56,
      );
    };
    resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resize?.observe(container);
    update();
    const shell = element.closest('[data-web-shell-root]');
    const mutation = new MutationObserver(update);
    mutation.observe(element, { childList: true, subtree: true });
    if (shell)
      mutation.observe(shell, { attributes: true, attributeFilter: ['style'] });
    return () => {
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [ref, enabled]);
  return visible;
}
