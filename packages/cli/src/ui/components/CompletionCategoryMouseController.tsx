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
import { findElementAtMouseEvent } from '../utils/mouse-hit.js';
import { type SuggestionCategory } from '../utils/suggestions.js';

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
      if (event.name !== 'left-press') return;

      const index = findElementAtMouseEvent(
        containerRef.current,
        categoryRefs.current,
        event,
        terminalHeight,
        'rect',
      );
      if (index !== null && index < categories.length) {
        onSelectCategory(categories[index]);
      }
    },
    [containerRef, categoryRefs, categories, onSelectCategory, terminalHeight],
  );

  useMouseEvents(handleMouse, { isActive: true, tracking: 'button' });

  return null;
}
