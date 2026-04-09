/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '../tools/tool-names.js';
import { shouldAutoApproveShellInVibeMode } from './vibeModeApproval.js';

describe('shouldAutoApproveShellInVibeMode', () => {
  it('auto-approves safe dev commands in project scope', () => {
    const result = shouldAutoApproveShellInVibeMode(
      ToolNames.SHELL,
      { command: 'npm run dev' },
      '/workspace/project',
    );

    expect(result).toBe(true);
  });

  it('requires manual approval for sudo commands', () => {
    const result = shouldAutoApproveShellInVibeMode(
      ToolNames.SHELL,
      { command: 'sudo npm run dev' },
      '/workspace/project',
    );

    expect(result).toBe(false);
  });

  it('requires manual approval when directory escapes project root', () => {
    const result = shouldAutoApproveShellInVibeMode(
      ToolNames.SHELL,
      {
        command: 'npm run dev',
        directory: '/workspace/other-repo',
      },
      '/workspace/project',
    );

    expect(result).toBe(false);
  });

  it('requires manual approval for unsupported git subcommands', () => {
    const result = shouldAutoApproveShellInVibeMode(
      ToolNames.SHELL,
      { command: 'git push origin main' },
      '/workspace/project',
    );

    expect(result).toBe(false);
  });
});
