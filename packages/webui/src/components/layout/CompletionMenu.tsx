/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * CompletionMenu component - Autocomplete dropdown menu
 * Supports keyboard navigation and mouse interaction
 */

import type { FC } from 'react';
import { useEffect, useRef, useState, useMemo } from 'react';
import type { CompletionItem } from '../../types/completion.js';

/**
 * Props for CompletionMenu component
 */
export interface CompletionMenuProps {
  /** List of completion items to display */
  items: CompletionItem[];
  /** Callback when an item is selected */
  onSelect: (item: CompletionItem) => void;
  /** Callback when menu should close */
  onClose: () => void;
  /** Optional section title */
  title?: string;
  /** Initial selected index */
  selectedIndex?: number;
}

/**
 * Group items by their group property
 */
const groupItems = (
  items: CompletionItem[],
): Array<{ group: string | null; items: CompletionItem[] }> => {
  const groups: Map<string | null, CompletionItem[]> = new Map();

  for (const item of items) {
    const groupKey = item.group || null;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(item);
  }

  return Array.from(groups.entries()).map(([group, groupItems]) => ({
    group,
    items: groupItems,
  }));
};

/**
 * CompletionMenu component
 *
 * Features:
 * - Keyboard navigation (Arrow Up/Down, Enter, Escape)
 * - Mouse hover selection
 * - Click outside to close
 * - Auto-scroll to selected item
 * - Smooth enter animation
 * - Item grouping support
 *
 * @example
 * ```tsx
 * <CompletionMenu
 *   items={[
 *     { id: '1', label: 'file.ts', type: 'file' },
 *     { id: '2', label: 'folder', type: 'folder', group: 'Folders' }
 *   ]}
 *   onSelect={(item) => console.log('Selected:', item)}
 *   onClose={() => console.log('Closed')}
 * />
 * ```
 */
export const CompletionMenu: FC<CompletionMenuProps> = ({
  items,
  onSelect,
  onClose,
  title,
  selectedIndex = 0,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(selectedIndex);
  // Mount state to drive a simple Tailwind transition (replaces CSS keyframes)
  const [mounted, setMounted] = useState(false);
  // Track if selection change was from keyboard (should scroll) vs mouse (should not scroll)
  const isKeyboardNavigation = useRef(false);

  // Group items for display
  const groupedItems = useMemo(() => groupItems(items), [items]);
  const hasGroups = groupedItems.some((g) => g.group !== null);

  useEffect(() => {
    if (!items.length) {
      return;
    }
    const nextIndex = Math.min(Math.max(selectedIndex, 0), items.length - 1);
    setSelected(nextIndex);
  }, [items.length, selectedIndex]);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          isKeyboardNavigation.current = true;
          setSelected((prev) => Math.min(prev + 1, items.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          isKeyboardNavigation.current = true;
          setSelected((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          event.preventDefault();
          if (items[selected]) {
            onSelect(items[selected]);
          }
          break;
        case 'Escape':
          event.preventDefault();
          onClose();
          break;
        default:
          break;
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [items, selected, onSelect, onClose]);

  useEffect(() => {
    // Only scroll into view for keyboard navigation, not mouse hover
    if (!isKeyboardNavigation.current) {
      return;
    }
    isKeyboardNavigation.current = false;

    const selectedEl = listRef.current?.querySelector(
      `[data-index="${selected}"]`,
    );
    if (selectedEl && listRef.current) {
      // Use scrollIntoView only within the list container to avoid page scroll
      const listRect = listRef.current.getBoundingClientRect();
      const elRect = selectedEl.getBoundingClientRect();

      // Check if element is outside the visible area of the list
      if (elRect.top < listRect.top) {
        // Element is above visible area, scroll up
        selectedEl.scrollIntoView({ block: 'start', behavior: 'instant' });
      } else if (elRect.bottom > listRect.bottom) {
        // Element is below visible area, scroll down
        selectedEl.scrollIntoView({ block: 'end', behavior: 'instant' });
      }
    }
  }, [selected]);

  if (!items.length) {
    return null;
  }

  // Track global index for keyboard navigation
  let globalIndex = 0;

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={title ? `${title} suggestions` : 'Suggestions'}
      className={[
        'completion-menu',
        // Positioning and container styling
        'absolute bottom-full left-0 right-0 mb-2 flex flex-col overflow-hidden',
        'rounded-large border bg-[var(--app-menu-background)]',
        'border-[var(--app-input-border)] max-h-[50vh] z-[1000]',
        // Mount animation (fade + slight slide up) via keyframes
        mounted ? 'animate-completion-menu-enter' : '',
      ].join(' ')}
    >
      {/* Optional top spacer for visual separation from the input */}
      <div className="h-1" />
      <div
        ref={listRef}
        className={[
          // Semantic
          'completion-menu-list',
          // Scroll area
          'flex max-h-[300px] flex-col overflow-y-auto',
          // Spacing driven by theme vars
          'p-[var(--app-list-padding)] pb-2',
        ].join(' ')}
      >
        {title && !hasGroups && (
          <div className="completion-menu-section-label px-3 py-1 text-[var(--app-primary-foreground)] opacity-50 text-[0.9em]">
            {title}
          </div>
        )}
        {groupedItems.map((group, groupIdx) => (
          <div
            key={group.group || `ungrouped-${groupIdx}`}
            className="completion-menu-group"
          >
            {hasGroups && group.group && (
              <div className="completion-menu-section-label px-3 py-1.5 text-[var(--app-secondary-foreground)] text-[0.8em] uppercase tracking-wider">
                {group.group}
              </div>
            )}
            <div className="flex flex-col gap-[var(--app-list-gap)]">
              {group.items.map((item) => {
                const currentIndex = globalIndex++;
                const isActive = currentIndex === selected;
                return (
                  <div
                    key={item.id}
                    data-index={currentIndex}
                    role="option"
                    aria-selected={isActive}
                    onClick={() => onSelect(item)}
                    onMouseEnter={() => setSelected(currentIndex)}
                    className={[
                      // Semantic
                      'completion-menu-item',
                      // Hit area
                      'mx-1 cursor-pointer rounded-[var(--app-list-border-radius)]',
                      'p-[var(--app-list-item-padding)]',
                      // Active background
                      isActive ? 'bg-[var(--app-list-active-background)]' : '',
                    ].join(' ')}
                  >
                    <div className="completion-menu-item-row flex items-center justify-between gap-2">
                      {item.icon && (
                        <span className="completion-menu-item-icon inline-flex h-4 w-4 items-center justify-center text-[var(--vscode-symbolIcon-fileForeground,#cccccc)]">
                          {item.icon}
                        </span>
                      )}
                      <span
                        className={[
                          'completion-menu-item-label flex-1 truncate',
                          isActive
                            ? 'text-[var(--app-list-active-foreground)]'
                            : 'text-[var(--app-primary-foreground)]',
                        ].join(' ')}
                      >
                        {item.label}
                      </span>
                      {item.description && (
                        <span
                          className="completion-menu-item-desc max-w-[50%] truncate text-[0.9em] text-[var(--app-secondary-foreground)] opacity-70"
                          title={item.description}
                        >
                          {item.description}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
