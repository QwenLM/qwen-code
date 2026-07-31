/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * ContextIndicator component - Shows context usage as a circular progress indicator
 * Displays token usage information with tooltip
 */

import type { FC } from 'react';
import { Tooltip } from '../ui/Tooltip.js';

/**
 * Context usage information
 */
export interface ContextUsage {
  /** Percentage of context remaining (0-100) */
  percentLeft: number;
  /** Number of tokens used */
  usedTokens: number;
  /** Maximum token limit */
  tokenLimit: number;
}

/**
 * Props for ContextIndicator component
 */
export interface ContextIndicatorProps {
  /** Context usage data, null to hide indicator */
  contextUsage: ContextUsage | null;
}

/**
 * Format large numbers with 'k' suffix
 * @param value Number to format
 * @returns Formatted string (e.g., "1.5k" for 1500)
 */
const formatNumber = (value: number): string => {
  if (value >= 1000) {
    return `${(Math.round((value / 1000) * 10) / 10).toFixed(1)}k`;
  }
  return Math.round(value).toLocaleString();
};

/**
 * ContextIndicator component
 *
 * Features:
 * - Circular progress indicator showing context usage
 * - Tooltip with detailed usage information
 * - Accessible with proper ARIA labels
 *
 * @example
 * ```tsx
 * <ContextIndicator
 *   contextUsage={{
 *     percentLeft: 75,
 *     usedTokens: 25000,
 *     tokenLimit: 100000
 *   }}
 * />
 * ```
 */
export const ContextIndicator: FC<ContextIndicatorProps> = ({
  contextUsage,
}) => {
  if (!contextUsage) {
    return null;
  }

  // Calculate used percentage for the progress indicator
  // contextUsage.percentLeft is the percentage remaining, so 100 - percentLeft = percent used
  // Clamp percentUsed to valid range [0, 100] before SVG calculations
  const percentUsed = Math.max(
    0,
    Math.min(100, 100 - contextUsage.percentLeft),
  );
  const percentFormatted = Math.round(percentUsed);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  // To show the used portion, we need to offset the unused portion
  // If 20% is used, we want to show 20% filled, so offset the remaining 80%
  const dashOffset = ((100 - percentUsed) / 100) * circumference;

  // Create tooltip content with proper formatting
  const tooltipContent = (
    <div className="flex flex-col gap-1">
      <div className="font-medium">
        {percentFormatted}% • {formatNumber(contextUsage.usedTokens)} /{' '}
        {formatNumber(contextUsage.tokenLimit)} context used
      </div>
    </div>
  );

  const ariaLabel = `${percentFormatted}% • ${formatNumber(contextUsage.usedTokens)} / ${formatNumber(contextUsage.tokenLimit)} context used`;

  return (
    <Tooltip content={tooltipContent} position="top">
      <button type="button" className="btn-icon-compact" aria-label={ariaLabel}>
        <svg viewBox="0 0 24 24" aria-hidden="true" role="presentation">
          <circle
            className="context-indicator__track"
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="currentColor"
            opacity="0.2"
          />
          <circle
            className="context-indicator__progress"
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{
              transform: 'rotate(-90deg)',
              transformOrigin: '50% 50%',
            }}
          />
        </svg>
      </button>
    </Tooltip>
  );
};
