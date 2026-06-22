/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SimpleGit } from 'simple-git';

export async function initRepositoryWithMainBranch(
  git: SimpleGit,
): Promise<void> {
  await git.init(false);
  await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
}
