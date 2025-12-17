/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { CompletionItem } from '../../../types/completionItemTypes.js';

interface CompletionMenuProps {
  items: CompletionItem[];
  onSelect: (item: CompletionItem) => void;
  onClose: () => void;
  title?: string;
  selectedIndex?: number;
}

export const CompletionMenu: React.FC<CompletionMenuProps> = ({
  items,
  onSelect,
  onClose,
  title,
  selectedIndex = 0,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(selectedIndex);
  // Mount state to drive a simple Tailwind transition (replaces CSS keyframes)
  const [mounted, setMounted] = useState(false);

  useEffect(() => setSelected(selectedIndex), [selectedIndex]);
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
          setSelected((prev) => Math.min(prev + 1, items.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
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
    const selectedEl = containerRef.current?.querySelector(
      `[data-index="${selected}"]`,
    );
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  if (!items.length) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      role="menu"
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
        className={[
          // Semantic
          'completion-menu-list',
          // Scroll area
          'flex max-h-[300px] flex-col overflow-y-auto',
          // Spacing driven by theme vars
          'p-[var(--app-list-padding)] pb-2 gap-[var(--app-list-gap)]',
        ].join(' ')}
      >
        {title && (
          <div className="completion-menu-section-label px-3 py-1 text-[var(--app-primary-foreground)] opacity-50 text-[0.9em]">
            {title}
          </div>
        )}
        {items.map((item, index) => {
          const isActive = index === selected;
          return (
            <div
              key={item.id}
              data-index={index}
              role="menuitem"
              onClick={() => onSelect(item)}
              onMouseEnter={() => setSelected(index)}
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
  );
};
