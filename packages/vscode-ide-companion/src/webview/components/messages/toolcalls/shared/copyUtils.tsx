/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared copy utilities for toolcall components
 */

import type React from 'react';
import { useState } from 'react';

/**
 * Handle copy to clipboard
 */
export const handleCopyToClipboard = async (
  text: string,
  event: React.MouseEvent,
): Promise<void> => {
  event.stopPropagation(); // Prevent triggering the row click
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text:', err);
  }
};

/**
 * Copy button component props
 */
interface CopyButtonProps {
  text: string;
}

/**
 * Shared copy button component with Tailwind styles
 * Note: Parent element should have 'group' class for hover effect
 */
export const CopyButton: React.FC<CopyButtonProps> = ({ text }) => {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <button
      className="col-start-3 bg-transparent border-none px-2 py-1.5 cursor-pointer text-[var(--app-secondary-foreground)] opacity-0 transition-opacity duration-200 ease-out flex items-center justify-center rounded relative group-hover:opacity-70 hover:!opacity-100 hover:bg-[var(--app-input-border)] active:scale-95"
      onClick={async (e) => {
        await handleCopyToClipboard(text, e);
        setShowTooltip(true);
        setTimeout(() => setShowTooltip(false), 1000);
      }}
      title="Copy"
      aria-label="Copy to clipboard"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M4 4V3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V11C14 11.5523 13.5523 12 13 12H12M3 6H11C11.5523 6 12 6.44772 12 7V13C12 13.5523 11.5523 14 11 14H3C2.44772 14 2 13.5523 2 13V7C2 6.44772 2.44772 6 3 6Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {showTooltip && (
        <span className="absolute -top-7 right-0 bg-[var(--app-tool-background)] text-[var(--app-primary-foreground)] px-2 py-1 rounded text-xs whitespace-nowrap border border-[var(--app-input-border)] pointer-events-none">
          Copied!
        </span>
      )}
    </button>
  );
};
