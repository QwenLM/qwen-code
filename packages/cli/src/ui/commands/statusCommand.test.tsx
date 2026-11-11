/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { statusCommand } from './statusCommand.js';
import { MessageType } from '../types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('statusCommand', () => {
  it('uses config session id for the status dialog', () => {
    const context = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getModel: vi.fn().mockReturnValue('test-model'),
            getActiveModel: vi.fn().mockReturnValue('active-test-model'),
            getSessionId: vi.fn().mockReturnValue('tui-session-123'),
          },
        },
      },
      session: {
        stats: {
          sessionStartTime: new Date('2026-04-14T12:00:00.000Z'),
          metrics: {
            models: {},
            tools: {
              totalCalls: 0,
              totalSuccess: 0,
              totalFail: 0,
              totalDurationMs: 0,
              totalDecisions: { accept: 0, reject: 0, modify: 0 },
              byName: {},
            },
          },
        },
      },
    });

    const result = statusCommand.action?.(context, '');

    expect(result).toMatchObject({ type: 'custom_dialog' });
    const element = result && 'component' in result ? result.component : null;
    expect(isValidElement(element)).toBe(true);
    const sessionId = isValidElement(element)
      ? (element as ReactElement<{ sessionId: string }>).props.sessionId
      : undefined;
    const currentModel = isValidElement(element)
      ? (element as ReactElement<{ currentModel: string }>).props.currentModel
      : undefined;
    expect(sessionId).toBe('tui-session-123');
    expect(currentModel).toBe('active-test-model');
  });

  it('shows error when config session id is unavailable', () => {
    const context = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getModel: vi.fn().mockReturnValue('test-model'),
            getActiveModel: vi.fn().mockReturnValue('active-test-model'),
            getSessionId: vi.fn().mockReturnValue(''),
          },
        },
      },
    });

    const result = statusCommand.action?.(context, '');

    expect(result).toBeUndefined();
    expect(context.ui.addItem).toHaveBeenCalledWith({
      type: MessageType.ERROR,
      text: 'Session context not available.',
    });
  });
});
