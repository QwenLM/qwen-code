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
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
        <div className="min-w-0 truncate text-sm leading-6 text-[var(--vscode-foreground)]">
          {stage}
        </div>
        <div className="row-span-2 shrink-0 self-center text-xs leading-none tabular-nums text-[var(--vscode-descriptionForeground)]">
          {percent}%
        </div>
        {detail ? (
          <div className="min-w-0 truncate text-xs leading-5 text-[var(--vscode-descriptionForeground)]">
            {detail}
          </div>
        ) : (
          <div className="text-xs leading-5 text-[var(--vscode-descriptionForeground)]">
            Processing your chat history…
          </div>
        )}
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
