/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  readGitHead,
  resolveGitRepositoryLayout,
} from '@qwen-code/core';

export const HEADLESS_TRANSCRIPT_ENTRYPOINT = 'cli';
export const REMOTE_WORKER_TRANSCRIPT_ENTRYPOINT = 'remote-control';
const TRANSCRIPT_GIT_METADATA_TIMEOUT_MS = 2_000;

export async function getTranscriptGitBranch(cwd: string): Promise<string> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () =>
      controller.abort(
        new Error('Transcript Git metadata collection exceeded its deadline'),
      ),
    TRANSCRIPT_GIT_METADATA_TIMEOUT_MS,
  );
  deadline.unref?.();
  try {
    const options = {
      signal: controller.signal,
      timeoutMs: TRANSCRIPT_GIT_METADATA_TIMEOUT_MS,
    };
    const layout = await resolveGitRepositoryLayout(cwd, options);
    if (!layout) return 'HEAD';
    return (await readGitHead(layout, options))?.branch ?? 'HEAD';
  } catch {
    return 'HEAD';
  } finally {
    clearTimeout(deadline);
  }
}
