/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type MutableRefObject, useCallback } from 'react';
import { type DOMElement } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import { type MouseEvent } from '../utils/mouse.js';
import {
  layoutRowForEvent,
  measureElementPosition,
} from '../utils/measure-element-position.js';
import { type SuggestionCategory } from '../utils/suggestions.js';
import { pointInViewport } from '../selection/selection-coords.js';

type CompletionCategory = SuggestionCategory | 'all';

interface CompletionCategoryMouseControllerProps {
  containerRef: MutableRefObject<DOMElement | null>;
  categoryRefs: MutableRefObject<Array<DOMElement | null>>;
  categories: readonly CompletionCategory[];
  onSelectCategory: (category: CompletionCategory) => void;
}

/**
 * Headless click layer for the completion category tabs.
 *
 * Coordinates assume the alternate-screen virtual viewport used by the owning
 * suggestion UI. Ink bottom-pins an overflowing frame, so terminal rows must
 * pass through `layoutRowForEvent` before they are compared with layout-space
 * tab rectangles. Inline mode is intentionally unsupported; mount this only
 * behind the owning surface's `mouseEnabled` gate.
 */
export function CompletionCategoryMouseController({
  containerRef,
  categoryRefs,
  categories,
  onSelectCategory,
}: CompletionCategoryMouseControllerProps): null {
  const { rows: terminalHeight } = useTerminalSize();

  const handleMouse = useCallback(
    (event: MouseEvent) => {
      if (event.name !== 'left-press' || !containerRef.current) return;

      const col = event.col - 1;
      const row = layoutRowForEvent(
        containerRef.current,
        event.row,
        terminalHeight,
      );

      for (let i = 0; i < categories.length; i++) {
        const node = categoryRefs.current[i];
        if (!node) continue;
        const rect = measureElementPosition(node);
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          pointInViewport({ x: col, y: row }, rect)
        ) {
          onSelectCategory(categories[i]);
          return;
        }
      }
    },
    [containerRef, categoryRefs, categories, onSelectCategory, terminalHeight],
  );

  useMouseEvents(handleMouse, { isActive: true, tracking: 'button' });

  return null;
}
