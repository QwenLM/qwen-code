/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ComputerUseClient } from './client.js';

export interface BootstrapContext {
  signal: AbortSignal;
  updateOutput?: (output: string) => void;
}

/**
 * STUB: Phase 3 (Task 10) replaces this with the full state machine
 * (install confirm → install → permission probe → guide → poll).
 * For now: assumes binary is installed and permissions granted;
 * just starts the client if needed.
 */
export async function runBootstrap(
  client: ComputerUseClient,
  _ctx: BootstrapContext,
): Promise<void> {
  if (!client.isStarted()) {
    await client.start();
  }
}
