/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Tooltip } from '../Tooltip.js';

interface ContextUsage {
  percentLeft: number;
  usedTokens: number;
  tokenLimit: number;
}

interface ContextIndicatorProps {
  contextUsage: ContextUsage | null;
}

export const ContextIndicator: React.FC<ContextIndicatorProps> = ({
  contextUsage,
}) => {
  if (!contextUsage) {
    return null;
  }

  // Calculate used percentage for the progress indicator
  // contextUsage.percentLeft is the percentage remaining, so 100 - percentLeft = percent used
  const percentUsed = 100 - contextUsage.percentLeft;
  const percentFormatted = Math.max(0, Math.min(100, Math.round(percentUsed)));
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  // To show the used portion, we need to offset the unused portion
  // If 20% is used, we want to show 20% filled, so offset the remaining 80%
  const dashOffset = ((100 - percentUsed) / 100) * circumference;
  const formatNumber = (value: number) => {
    if (value >= 1000) {
      return `${(Math.round((value / 1000) * 10) / 10).toFixed(1)}k`;
    }
    return Math.round(value).toLocaleString();
  };

  // Create tooltip content with proper formatting
  const tooltipContent = (
    <div className="flex flex-col gap-1">
      <div className="font-medium">
        {percentFormatted}% • {formatNumber(contextUsage.usedTokens)} /{' '}
        {formatNumber(contextUsage.tokenLimit)} context used
      </div>
    </div>
  );

  return (
    <Tooltip content={tooltipContent} position="top">
      <button
        className="btn-icon-compact"
        aria-label={`${percentFormatted}% • ${formatNumber(contextUsage.usedTokens)} / ${formatNumber(contextUsage.tokenLimit)} context used`}
      >
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
