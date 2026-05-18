/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';

export interface DaemonTuiRuntimeOptions {
  enabled: boolean;
  daemonUrl: string;
  token?: string;
  sessionId?: string;
  sessionScope?: 'single' | 'thread';
  model?: string;
  workspaceCwd: string;
}

function isEnabled(value: string | undefined): boolean {
  // Accept the common hidden-flag/env conventions used by local smoke scripts.
  return value === '1' || value === 'true' || value === 'yes';
}

function readSessionScope(): 'single' | 'thread' | undefined {
  const value = process.env['QWEN_DAEMON_SESSION_SCOPE'];
  return value === 'single' || value === 'thread' ? value : undefined;
}

export function getDaemonTuiRuntimeOptions(
  config: Config,
): DaemonTuiRuntimeOptions {
  const enabled = isEnabled(process.env['QWEN_EXPERIMENTAL_DAEMON_TUI']);
  return {
    enabled,
    daemonUrl: process.env['QWEN_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
    token: process.env['QWEN_DAEMON_TOKEN'],
    sessionId: process.env['QWEN_DAEMON_SESSION_ID'],
    sessionScope: readSessionScope(),
    model: process.env['QWEN_DAEMON_MODEL'] ?? config.getModel(),
    // For local-local runs this falls back to the current target dir. For
    // local-TUI-to-remote-daemon runs, callers must pass the daemon-visible
    // workspace path explicitly.
    workspaceCwd: process.env['QWEN_DAEMON_WORKSPACE'] ?? config.getTargetDir(),
  };
}
