/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { joinCommands } from './add-runtime-dialog';

describe('joinCommands', () => {
  const join = {
    token: 'secret-token',
    workspaceId: 'workspace-id',
    expiresAt: Date.now() + 60_000,
  };

  it('quotes the coordinator address and keeps the token out of qwen argv', () => {
    const command = joinCommands("https://host/base'$(id)'", join).qwen;

    expect(command).toContain(
      "QWEN_AGENT_HOST_ENROLLMENT_TOKEN='secret-token'",
    );
    expect(command).toContain("'\"'\"'");
    expect(command).toContain('--join ');
    expect(command.match(/secret-token/g)).toHaveLength(1);
  });

  it('rejects coordinator addresses with URL parameters', () => {
    expect(() => joinCommands('https://host/base?next=other', join)).toThrow(
      'Invalid coordinator address.',
    );
  });
});
