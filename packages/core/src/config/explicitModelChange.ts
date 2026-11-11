/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from './config.js';

/**
 * Applies a user- or host-requested model switch.
 *
 * Returns false when the switch did not land: another change won the race
 * (the active model or request identity moved while `setModel` ran), even if
 * the settings write itself succeeded.
 */
export async function applyExplicitModelChange(
  config: Config,
  newModel: string,
  options: {
    /** Where the change came from (slash, dialog, remote, headless_control…). */
    trigger: string;
    /** Passed straight to `Config.setModel` (defaults to its own default). */
    isTemporary?: boolean;
    persisted: boolean;
  },
): Promise<boolean> {
  const identity = config.getModelRequestIdentity();
  const saved = await config.setModel(newModel, options.isTemporary);
  if (
    config.getModel() !== newModel ||
    identity !== config.getModelRequestIdentity()
  )
    return false;
  return saved;
}
