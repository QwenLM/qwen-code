/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopProject } from '../../api/client.js';

export function formatGitStatus(status: DesktopProject['gitStatus']): string {
  if (!status.isRepository) {
    return 'No Git repository';
  }

  if (status.clean) {
    return 'Clean';
  }

  return `${status.modified} modified · ${status.staged} staged · ${status.untracked} untracked`;
}
