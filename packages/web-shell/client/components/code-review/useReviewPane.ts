import { useLayoutEffect, useRef, useState } from 'react';
import {
  usePanelRef,
  type GroupProps,
  type Layout,
} from 'react-resizable-panels';

export function useReviewPane(
  name: 'inbox' | 'context',
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
  breakpoint: number,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = usePanelRef();
  const [wide, setWide] = useState(false);
  const [userLayout, setUserLayout] = useState<Layout | null>(null);
  const storageKey = `qwen-code-review-${name}-width`;
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored > 0) {
        return Math.min(maxWidth, Math.max(minWidth, stored));
      }
    } catch {
      // Embedded hosts may disable local storage.
    }
    return defaultWidth;
  });

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () =>
      setWide(element.getBoundingClientRect().width > breakpoint);
    update();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [breakpoint]);

  useLayoutEffect(() => {
    if (!userLayout || !panelRef.current) return;
    // Keyboard layout callbacks run before the panel's DOM width is updated.
    const nextWidth = Math.round(panelRef.current.getSize().inPixels);
    setWidth(nextWidth);
    try {
      window.localStorage.setItem(storageKey, String(nextWidth));
    } catch {
      // Resizing still works when preferences cannot be persisted.
    }
  }, [panelRef, storageKey, userLayout]);

  const onLayoutChanged: GroupProps['onLayoutChanged'] = (layout, meta) => {
    if (meta.isUserInteraction) setUserLayout(layout);
  };

  return { containerRef, panelRef, wide, width, onLayoutChanged };
}
