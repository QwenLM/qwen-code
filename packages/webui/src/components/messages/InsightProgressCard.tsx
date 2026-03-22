/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';

export interface InsightProgressCardProps {
  stage: string;
  progress: number;
  detail?: string;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export const InsightProgressCard: FC<InsightProgressCardProps> = ({
  stage,
  progress,
  detail,
}) => {
  const percent = clamp(progress);

  return (
    <div className="w-full px-[30px] py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-[var(--vscode-foreground)]">
            {stage}
          </div>
          {detail ? (
            <div className="mt-1 truncate text-xs text-[var(--vscode-descriptionForeground)]">
              {detail}
            </div>
          ) : (
            <div className="mt-1 text-xs text-[var(--vscode-descriptionForeground)]">
              Processing your chat history…
            </div>
          )}
        </div>
        <div className="shrink-0 text-xs tabular-nums text-[var(--vscode-descriptionForeground)]">
          {percent}%
        </div>
      </div>

      <div className="mt-2 h-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--vscode-widget-border,var(--vscode-panel-border,#2a2f3a))_70%,transparent)]">
        <div
          className="h-full rounded-full bg-[var(--vscode-progressBar-background,#0e70c0)] transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};
