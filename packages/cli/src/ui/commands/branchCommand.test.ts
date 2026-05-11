/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { branchCommand } from './branchCommand.js';
import type { CommandContext } from './types.js';

function makeCtx(
  overrides: {
    isIdle?: boolean;
    sessionExists?: boolean;
    noConfig?: boolean;
  } = {},
): CommandContext {
  const sessionService = {
    sessionExists: vi.fn().mockResolvedValue(overrides.sessionExists ?? true),
  };
  const config = overrides.noConfig
    ? null
    : ({
        getSessionId: () => '11111111-1111-1111-1111-111111111111',
        getSessionService: () => sessionService,
      } as unknown as NonNullable<CommandContext['services']['config']>);
  return {
    services: { config, settings: {} as never, git: undefined, logger: null },
    ui: {
      isIdleRef: { current: overrides.isIdle ?? true },
    } as unknown as CommandContext['ui'],
    session: { stats: {} as never, sessionShellAllowlist: new Set() },
  } as unknown as CommandContext;
}

describe('branchCommand', () => {
  it('rejects when config is unavailable', async () => {
    const result = await branchCommand.action!(makeCtx({ noConfig: true }), '');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
  });

  it('rejects when no conversation exists to branch from', async () => {
    const result = await branchCommand.action!(
      makeCtx({ sessionExists: false }),
      '',
    );
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toMatch(
      /No conversation to branch/,
    );
  });

  it('rejects while streaming or awaiting a tool confirmation', async () => {
    const result = await branchCommand.action!(makeCtx({ isIdle: false }), '');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toMatch(/in progress/);
  });

  it('returns dialog action with no name when args are empty', async () => {
    const result = await branchCommand.action!(makeCtx(), '   ');
    expect(result).toEqual({ type: 'dialog', dialog: 'branch' });
  });

  it('returns dialog action with trimmed name when args are provided', async () => {
    const result = await branchCommand.action!(makeCtx(), '  my-branch  ');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'branch',
      name: 'my-branch',
    });
  });

  it('exposes /fork as an alias', () => {
    expect(branchCommand.altNames).toContain('fork');
  });
});
