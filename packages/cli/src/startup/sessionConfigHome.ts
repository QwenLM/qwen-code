/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Called after --config-dir, before loading runtime consumers. */
export async function initializeSessionConfigHome(): Promise<void> {
  const [{ getConfigHomeDir }, { setConfigHomeDir }] = await Promise.all([
    import('@qwen-code/core'),
    import('@qwen-code/core/sessions'),
  ]);
  setConfigHomeDir(getConfigHomeDir());
}
