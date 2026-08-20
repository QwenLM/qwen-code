/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type FC, type ReactNode } from 'react';
import { useControlledExpanded } from '../../../context/ExpandControlContext.js';

interface CollapsibleOutputProps {
  children: ReactNode;
  isCollapsible: boolean;
  collapsedHeight?: number;
  fadeStart?: number;
  className?: string;
}

/**
 * Renderer-agnostic wrapper for long tool output.
 */
export const CollapsibleOutput: FC<CollapsibleOutputProps> = ({
  children,
  isCollapsible,
  collapsedHeight = 200,
  fadeStart = 140,
  className = '',
}) => {
  const [isExpanded, setIsExpanded] = useControlledExpanded(false);

  return (
    <div className="flex flex-col gap-[3px]">
      <div
        className={`toolcall-collapsible-output-content overflow-hidden ${className}`}
        style={
          !isExpanded && isCollapsible
            ? {
                maxHeight: `${collapsedHeight}px`,
                maskImage: `linear-gradient(to bottom, var(--app-primary-background) ${fadeStart}px, transparent ${collapsedHeight}px)`,
                WebkitMaskImage: `linear-gradient(to bottom, var(--app-primary-background) ${fadeStart}px, transparent ${collapsedHeight}px)`,
              }
            : undefined
        }
      >
        {children}
      </div>
      {isCollapsible && (
        <div className="flex justify-center border-t border-[var(--app-input-border)] pt-1">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setIsExpanded((expanded) => !expanded);
            }}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse output' : 'Expand output'}
            className="text-[var(--app-secondary-foreground)] text-[0.8em] hover:text-[var(--app-primary-foreground)] cursor-pointer bg-transparent border-none px-2 py-1 rounded hover:bg-[var(--app-input-background)] transition-colors"
          >
            {isExpanded ? '▲ Collapse' : '▼ Show more'}
          </button>
        </div>
      )}
    </div>
  );
};
