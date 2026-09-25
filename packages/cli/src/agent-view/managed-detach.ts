/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ensureAgentViewSupervisor } from './supervisor-runner.js';
import type { AgentViewSupervisorClientHandle } from './supervisor-runner.js';

interface DetachableConfig {
  getSessionId(): string;
  getProjectRoot(): string;
  getTargetDir(): string;
  getApprovalMode(): unknown;
  getSandbox(): unknown;
}

interface DetachTerminalSize {
  columns: number;
  rows: number;
}

interface DetachOptions {
  globalDir?: string;
  terminal?: Partial<DetachTerminalSize>;
  ensureSupervisor?: (options: {
    globalDir?: string;
  }) => Promise<Pick<AgentViewSupervisorClientHandle, 'adopt'>>;
}

export async function detachCurrentSessionToAgentView(
  config: DetachableConfig,
  options: DetachOptions = {},
): Promise<{ sessionId: string }> {
  const sessionId = config.getSessionId();
  const projectCwd = path.resolve(config.getProjectRoot());
  const activeCwd = path.resolve(config.getTargetDir());
  const supervisor = await (
    options.ensureSupervisor ?? ensureAgentViewSupervisor
  )(storeOptions(options));

  await supervisor.adopt({
    sessionId,
    projectCwd,
    activeCwd,
    approvalMode: stringifyOptional(config.getApprovalMode()),
    sandbox: stringifySandbox(config.getSandbox()),
    terminal: {
      columns: options.terminal?.columns ?? process.stdout.columns ?? 80,
      rows: options.terminal?.rows ?? process.stdout.rows ?? 24,
    },
  });
  return { sessionId };
}

function stringifyOptional(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function stringifySandbox(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function storeOptions(options: DetachOptions): { globalDir?: string } {
  return options.globalDir ? { globalDir: options.globalDir } : {};
}
