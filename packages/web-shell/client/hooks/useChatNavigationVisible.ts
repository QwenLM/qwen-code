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
      const style = getComputedStyle(element);
      const minWidth =
        Number.parseFloat(
          style.getPropertyValue('--chat-regular-content-width'),
        ) || 1000;
      // Reserve 64px gutters so hover-expanded ticks stay clear of the text.
      setVisible(
        style.getPropertyValue('--chat-content-width').trim() !== '100%' &&
          container.getBoundingClientRect().width >= minWidth + 128,
      );
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
