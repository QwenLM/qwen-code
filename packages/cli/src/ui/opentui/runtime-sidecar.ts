/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * runtime.json sidecar for the OpenTUI entry (ink parity).
 *
 * The ink branch of `startInteractiveUI` writes a small `runtime.json`
 * sidecar next to the chat log so external tools (terminal multiplexers, IDE
 * integrations, status daemons) can map the running PID back to its session
 * id and work directory, then calls `config.markRuntimeStatusEnabled()` to
 * arm the session-swap refresh in `Config.startNewSession()` — without that
 * call the sidecar would never update on `/clear` or `/resume`. The OpenTUI
 * branch skipped both. This module mirrors `startInteractiveUI.tsx:106-122`.
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { writeRuntimeStatus } from '@qwen-code/qwen-code-core';
import { getCliVersion } from '../../utils/version.js';

/**
 * Writes the runtime sidecar for the current session and arms the
 * session-swap refresh. Best-effort: a read-only filesystem (or any failure)
 * must never block the UI from starting.
 */
export async function writeRuntimeSidecar(config: Config): Promise<boolean> {
  try {
    const version = await getCliVersion();
    const sessionId = config.getSessionId();
    const runtimeStatusPath = config.storage.getRuntimeStatusPath(sessionId);
    await writeRuntimeStatus(runtimeStatusPath, {
      sessionId,
      workDir: config.getTargetDir(),
      qwenVersion: version,
    });
    config.markRuntimeStatusEnabled();
    return true;
  } catch {
    return false;
  }
}
