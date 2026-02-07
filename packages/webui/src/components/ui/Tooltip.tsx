/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';

/**
 * Tooltip component props
 */
export interface TooltipProps {
  /** Content to wrap with tooltip */
  children: React.ReactNode;
  /** Tooltip content (can be string or ReactNode) */
  content: React.ReactNode;
  /** Tooltip position relative to children */
  position?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Tooltip component using CSS group-hover for display
 * Supports CSS variables for theming
 */
export const Tooltip: FC<TooltipProps> = ({
  children,
  content,
  position = 'top',
}) => (
  <div className="relative inline-block">
    <div className="group relative">
      {children}
      <div
        className={`
          absolute z-50 px-2 py-1 text-xs rounded-md shadow-lg
          bg-[var(--app-primary-background,#1f2937)] border border-[var(--app-input-border,#374151)]
          text-[var(--app-primary-foreground,#f9fafb)] whitespace-nowrap
          opacity-0 group-hover:opacity-100 transition-opacity duration-150
          -translate-x-1/2 left-1/2
          ${
            position === 'top'
              ? '-translate-y-1 bottom-full mb-1'
              : position === 'bottom'
                ? 'translate-y-1 top-full mt-1'
                : position === 'left'
                  ? '-translate-x-full left-0 translate-y-[-50%] top-1/2'
                  : 'translate-x-0 right-0 translate-y-[-50%] top-1/2'
          }
          pointer-events-none
        `}
      >
        {content}
        <div
          className={`
            absolute w-2 h-2 bg-[var(--app-primary-background,#1f2937)] border-l border-b border-[var(--app-input-border,#374151)]
            -rotate-45
            ${
              position === 'top'
                ? 'top-full left-1/2 -translate-x-1/2 -translate-y-1/2'
                : position === 'bottom'
                  ? 'bottom-full left-1/2 -translate-x-1/2 translate-y-1/2'
                  : position === 'left'
                    ? 'right-full top-1/2 translate-x-1/2 -translate-y-1/2'
                    : 'left-full top-1/2 -translate-x-1/2 -translate-y-1/2'
            }
          `}
        />
      </div>
    </div>
  </div>
);

export default Tooltip;
