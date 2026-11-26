/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readEnvironmentVariable } from './storage-paths-lite.js';
import type { Settings } from './settingsSchema.js';

/**
 * Whether LSP was opted into, independent of which surface asked.
 *
 * `--experimental-lsp` cannot reach hosts that build their own argv — the
 * Desktop client pins the daemon's arguments in Rust — so the setting and the
 * env pair exist as parallel entrances to one subsystem. The kill switch wins
 * over all of them, matching `QWEN_CODE_DISABLE_WORKFLOWS`.
 *
 * `settings` is the merged layer the caller already holds, so a workspace
 * value cannot leak in: `tools.lspEnabled` is registered in
 * `WORKSPACE_RESTRICTED_SETTINGS` and stripped before the merge. Both env keys
 * sit in `PROJECT_ENV_HARDCODED_EXCLUSIONS`, so no repository content can
 * spend the user's permissions by starting language servers on its own behalf.
 */
export function isLspOptedIn(
  argvExperimentalLsp: boolean | undefined,
  settings: Settings | undefined,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  // `readEnvironmentVariable` folds case on Windows, where a spawned process
  // sees `QWEN_CODE_ENABLE_LSP` however it was spelled. Without it a
  // lower-cased home `.env` key would be invisible here while the session host
  // honoured it, and the engine check would certify a session that starts
  // language servers.
  if (readEnvironmentVariable(env, 'QWEN_CODE_DISABLE_LSP') === '1') {
    return false;
  }
  return (
    argvExperimentalLsp === true ||
    readEnvironmentVariable(env, 'QWEN_CODE_ENABLE_LSP') === '1' ||
    settings?.tools?.lspEnabled === true
  );
}
