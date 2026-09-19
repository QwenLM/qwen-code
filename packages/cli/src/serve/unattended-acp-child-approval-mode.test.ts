/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { resetHomeEnvBootstrapForTesting } from '../config/settings.js';
import { resolveUnattendedAcpChildApprovalModeForWorkspace } from './unattended-acp-child-approval-mode.js';

describe('resolveUnattendedAcpChildApprovalModeForWorkspace', () => {
  let tmpDir: string;
  let workspace: string;
  const originalQwenHome = process.env['QWEN_HOME'];
  const originalQwenRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
  const originalSystemSettings = process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
  const originalSystemDefaults = process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
  const originalSafeMode = process.env['QWEN_CODE_SAFE_MODE'];
  const originalBareMode = process.env['QWEN_CODE_SIMPLE'];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unattended-approval-'));
    workspace = path.join(tmpDir, 'workspace');
    const qwenHome = path.join(tmpDir, 'qwen-home');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(qwenHome, { recursive: true });
    process.env['QWEN_HOME'] = qwenHome;
    process.env['QWEN_RUNTIME_DIR'] = path.join(tmpDir, 'runtime');
    process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = path.join(
      tmpDir,
      'system-settings.json',
    );
    process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] = path.join(
      tmpDir,
      'system-defaults.json',
    );
    delete process.env['QWEN_CODE_SAFE_MODE'];
    delete process.env['QWEN_CODE_SIMPLE'];
    resetHomeEnvBootstrapForTesting();
  });

  afterEach(async () => {
    restoreEnv('QWEN_HOME', originalQwenHome);
    restoreEnv('QWEN_RUNTIME_DIR', originalQwenRuntimeDir);
    restoreEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', originalSystemSettings);
    restoreEnv('QWEN_CODE_SYSTEM_DEFAULTS_PATH', originalSystemDefaults);
    restoreEnv('QWEN_CODE_SAFE_MODE', originalSafeMode);
    restoreEnv('QWEN_CODE_SIMPLE', originalBareMode);
    resetHomeEnvBootstrapForTesting();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('elevates a keyless workspace to auto so unattended children do not park', () => {
    expect(
      resolveUnattendedAcpChildApprovalModeForWorkspace(workspace),
    ).toBe(ApprovalMode.AUTO);
  });

  it('honors a workspace plan pin', async () => {
    await writeWorkspaceApprovalMode('plan');
    expect(
      resolveUnattendedAcpChildApprovalModeForWorkspace(workspace),
    ).toBe(ApprovalMode.PLAN);
  });

  it('honors a workspace default pin without escalating to auto', async () => {
    await writeWorkspaceApprovalMode('default');
    expect(
      resolveUnattendedAcpChildApprovalModeForWorkspace(workspace),
    ).toBe(ApprovalMode.DEFAULT);
  });

  it('keeps safe-mode workspaces on default even when a pin is present', async () => {
    process.env['QWEN_CODE_SAFE_MODE'] = '1';
    await writeWorkspaceApprovalMode('auto');
    expect(
      resolveUnattendedAcpChildApprovalModeForWorkspace(workspace),
    ).toBe(ApprovalMode.DEFAULT);
  });

  async function writeWorkspaceApprovalMode(mode: string): Promise<void> {
    const qwenDir = path.join(workspace, '.qwen');
    await fs.mkdir(qwenDir, { recursive: true });
    await fs.writeFile(
      path.join(qwenDir, 'settings.json'),
      JSON.stringify({ tools: { approvalMode: mode } }),
      'utf8',
    );
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
