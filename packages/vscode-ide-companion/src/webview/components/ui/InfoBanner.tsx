/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { TerminalIcon, CloseIcon } from '../icons/index.js';

interface InfoBannerProps {
  /**
   * Whether the banner is visible
   */
  visible: boolean;

  /**
   * Callback when the banner is dismissed
   */
  onDismiss: () => void;

  /**
   * Optional: Custom message content (if not provided, uses default)
   */
  message?: React.ReactNode;

  /**
   * Optional: Custom link text
   */
  linkText?: string;

  /**
   * Optional: Callback when the link is clicked
   */
  onLinkClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

export const InfoBanner: React.FC<InfoBannerProps> = ({
  visible,
  onDismiss,
  message,
  linkText = 'Switch back in Settings.',
  onLinkClick,
}) => {
  if (!visible) {
    return null;
  }

  return (
    <div
      className="flex items-center justify-between"
      style={{
        gap: '12px',
        padding: '8px 16px',
      }}
    >
      <div className="flex items-center flex-1 min-w-0" style={{ gap: '8px' }}>
        {/* Icon */}
        <TerminalIcon className="flex-shrink-0 w-4 h-4" />

        {/* Message */}
        <label
          className="m-0 leading-snug text-[11px]"
          style={{ color: 'var(--app-primary-foreground)' }}
        >
          {message || (
            <>
              Prefer the Terminal experience?{' '}
              {onLinkClick && (
                <a
                  href="#"
                  className="no-underline hover:underline cursor-pointer outline-none"
                  style={{ color: 'var(--app-qwen-orange)' }}
                  onClick={onLinkClick}
                >
                  {linkText}
                </a>
              )}
            </>
          )}
        </label>
      </div>

      {/* Close button */}
      <button
        className="flex items-center justify-center cursor-pointer rounded"
        style={{
          background: 'none',
          border: 'none',
          padding: '6px',
          color: 'var(--app-secondary-foreground)',
          borderRadius: '4px',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor =
            'var(--app-ghost-button-hover-background)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
        aria-label="Close banner"
        onClick={onDismiss}
      >
        <CloseIcon className="w-[10px] h-[10px]" />
      </button>
    </div>
  );
};
