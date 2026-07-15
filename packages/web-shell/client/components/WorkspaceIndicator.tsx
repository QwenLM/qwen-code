/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import styles from './ChatEditor.module.css';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

function WorkspaceFolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h7A1.5 1.5 0 0 1 19 8.5v8A1.5 1.5 0 0 1 17.5 18h-13A1.5 1.5 0 0 1 3 16.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A compact, non-interactive chip naming the workspace a split-view pane's
 * session belongs to. Mirrors {@link GitBranchIndicator}; both sit in the
 * composer toolbar. Shown only on a multi-workspace daemon (the pane composer
 * opts into the `workspace` toolbar action) so it's clear which workspace a
 * message goes to. The full cwd stays in a hover tooltip — matching the git
 * branch chip — so it's still discoverable once the name ellipsizes or
 * collapses to an icon on a narrow (split-screen / mobile) composer.
 */
export function WorkspaceIndicator({
  name,
  title,
  ariaLabel,
  compact = false,
}: {
  name: string;
  title: string;
  ariaLabel: string;
  compact?: boolean;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <output
            className={`${styles.workspaceChip} ${
              compact ? styles.workspaceChipCompact : ''
            }`}
            aria-label={ariaLabel}
            data-web-shell-workspace
            data-web-shell-workspace-title={title}
          >
            <span className={styles.workspaceChipIcon}>
              <WorkspaceFolderIcon />
            </span>
            <span className={styles.workspaceChipText}>{name}</span>
          </output>
        </TooltipTrigger>
        <TooltipContent side="top">{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
