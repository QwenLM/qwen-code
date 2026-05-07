/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { remoteControlCommand } from './remoteControlCommand.js';

const serverInfo = {
  url: 'http://127.0.0.1:7373',
  wsUrl: 'ws://127.0.0.1:7373/ws',
  lanUrls: ['http://192.168.1.23:7373'],
  lanWsUrls: ['ws://192.168.1.23:7373/ws'],
  pairingToken: 'pair-token',
  pairingExpiresAt: '2026-05-08T12:00:00.000Z',
};

describe('remoteControlCommand', () => {
  it('starts current TUI remote control', async () => {
    const remoteControl = {
      start: vi.fn().mockResolvedValue({
        info: serverInfo,
        alreadyStarted: false,
      }),
      stop: vi.fn(),
      getStatus: vi.fn(),
    };
    const context = createMockCommandContext({
      services: { remoteControl },
    });

    const result = await remoteControlCommand.action!(context, '');

    expect(remoteControl.start).toHaveBeenCalledWith({});
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect(result?.type === 'message' ? result.content : '').toContain(
      'Remote control attached to the current TUI session.',
    );
    expect(result?.type === 'message' ? result.content : '').toContain(
      'Pairing token: pair-token',
    );
  });

  it('uses 0.0.0.0 when LAN mode is requested without an explicit host', async () => {
    const remoteControl = {
      start: vi.fn().mockResolvedValue({
        info: serverInfo,
        alreadyStarted: false,
      }),
      stop: vi.fn(),
      getStatus: vi.fn(),
    };
    const context = createMockCommandContext({
      services: { remoteControl },
    });

    await remoteControlCommand.action!(
      context,
      'start --allow-lan --port 0 --token-ttl 60 --no-ui',
    );

    expect(remoteControl.start).toHaveBeenCalledWith({
      allowLan: true,
      host: '0.0.0.0',
      noUi: true,
      port: 0,
      tokenTtlMs: 60_000,
    });
  });

  it('reports status without starting a new server', async () => {
    const remoteControl = {
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        running: true,
        info: serverInfo,
      }),
    };
    const context = createMockCommandContext({
      services: { remoteControl },
    });

    const result = await remoteControlCommand.action!(context, 'status');

    expect(remoteControl.start).not.toHaveBeenCalled();
    expect(result?.type === 'message' ? result.content : '').toContain(
      'Remote control is running.',
    );
  });

  it('stops a running remote-control bridge', async () => {
    const remoteControl = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(true),
      getStatus: vi.fn(),
    };
    const context = createMockCommandContext({
      services: { remoteControl },
    });

    const result = await remoteControlCommand.action!(context, 'stop');

    expect(remoteControl.stop).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Remote control stopped for the current TUI session.',
    });
  });

  it('returns an error when the runtime service is unavailable', async () => {
    const context = createMockCommandContext();

    const result = await remoteControlCommand.action!(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Remote control service is not available.',
    });
  });
});
