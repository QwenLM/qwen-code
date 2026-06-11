/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SystemController } from './systemController.js';
import type { IControlContext } from '../ControlContext.js';
import type { IPendingRequestRegistry } from './baseController.js';

function buildController(
  contextOverrides: Partial<IControlContext> = {},
): SystemController {
  const context = {
    abortSignal: new AbortController().signal,
    debugMode: false,
    ...contextOverrides,
  } as unknown as IControlContext;
  const registry: IPendingRequestRegistry = {
    registerIncomingRequest: vi.fn(),
    deregisterIncomingRequest: vi.fn(),
    registerOutgoingRequest: vi.fn(),
    deregisterOutgoingRequest: vi.fn(),
  };
  return new SystemController(context, registry, 'system');
}

describe('SystemController continue_last_turn', () => {
  it('delegates to the session callback and merges its payload', async () => {
    const onContinueLastTurn = vi.fn().mockResolvedValue({
      accepted: true,
      interruption: 'interrupted_turn',
    });
    const controller = buildController({ onContinueLastTurn });

    const result = await controller.handleRequest(
      { subtype: 'continue_last_turn' },
      'req-1',
    );

    expect(onContinueLastTurn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      subtype: 'continue_last_turn',
      accepted: true,
      interruption: 'interrupted_turn',
    });
  });

  it('fails loudly when no session callback is registered', async () => {
    const controller = buildController();

    await expect(
      controller.handleRequest({ subtype: 'continue_last_turn' }, 'req-2'),
    ).rejects.toThrow(/continue_last_turn is not available/);
  });
});
