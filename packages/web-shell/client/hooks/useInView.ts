/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface UseInViewOptions {
  /**
   * Margin grown around the viewport before an element counts as visible, so
   * nearby work (syntax highlighting, chart rendering) can start slightly
   * before the element actually scrolls into view. Defaults to no margin.
   */
  rootMargin?: string;
}

export interface UseInViewResult<T extends Element> {
  ref: RefObject<T | null>;
  /** False until the element intersects the (padded) viewport. */
  inView: boolean;
}

function supportsIntersectionObserver(): boolean {
  return typeof IntersectionObserver !== 'undefined';
}

/**
 * Tracks whether an element is inside the viewport via IntersectionObserver.
 *
 * Seeds `inView` from feature support rather than optimism: with a real
 * observer the element is presumed offscreen until the first callback fires,
 * which is what lets consumers defer work for below-the-fold content. Where
 * the API is unavailable (SSR, jsdom), degrades to `true` so consumers keep
 * their pre-gating behavior instead of never running at all.
 */
export function useInView<T extends Element>(
  options: UseInViewOptions = {},
): UseInViewResult<T> {
  const { rootMargin } = options;
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(() => !supportsIntersectionObserver());

  useEffect(() => {
    const element = ref.current;
    if (!element || !supportsIntersectionObserver()) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}
