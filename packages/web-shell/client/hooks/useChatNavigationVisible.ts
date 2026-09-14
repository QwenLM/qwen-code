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
    const update = () => {
      const minWidth =
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue(
            '--chat-regular-content-width',
          ),
        ) || 1000;
      setVisible(container.getBoundingClientRect().width >= minWidth);
    };
    update();
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resize?.observe(container);
    const shell = element.closest('[data-web-shell-root]');
    const mutation = new MutationObserver(update);
    if (shell)
      mutation.observe(shell, { attributes: true, attributeFilter: ['style'] });
    return () => {
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [ref, enabled]);
  return visible;
}
