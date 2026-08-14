/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkspaceRuntimeProvenance } from './managed-scratch-workspace.js';

export function isInternalWorkspaceRuntime(runtime: {
  readonly provenance?: WorkspaceRuntimeProvenance;
}): boolean {
  return runtime.provenance === 'live-conversation';
}
