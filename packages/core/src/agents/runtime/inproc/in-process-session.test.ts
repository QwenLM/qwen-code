/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentEventEmitter, AgentEventType } from '../agent-events.js';
import type { AgentInteractive } from '../agent-interactive.js';
import { AgentStatus } from '../agent-types.js';
import { ToolConfirmationOutcome } from '../../../tools/tools.js';
import { InProcessSession } from './in-process-session.js';

describe('InProcessSession', () => {
  it('drops pending approvals when the active turn is cancelled', async () => {
    const emitter = new AgentEventEmitter();
    const respond = vi.fn().mockResolvedValue(undefined);
    const interactive = {
      getCore: () => ({
        runtimeContext: {
          getTargetDir: () => '/tmp',
          getApprovalMode: () => 'default',
          setApprovalMode: vi.fn(),
        },
        modelConfig: {},
      }),
      getMessages: () => [],
      getPendingApprovals: () =>
        new Map([
          [
            'call-1',
            { type: 'info', title: 'Confirm', prompt: '?', onConfirm: respond },
          ],
        ]),
      getEventEmitter: () => emitter,
    } as unknown as AgentInteractive;
    const session = new InProcessSession('agent-1', 'team-1', interactive);

    emitter.emit(AgentEventType.STATUS_CHANGE, {
      agentId: 'agent-1',
      previousStatus: AgentStatus.RUNNING,
      newStatus: AgentStatus.IDLE,
      turnId: 'turn-1',
      roundCancelledByUser: true,
      timestamp: Date.now(),
    });
    await session.answer({
      callId: 'call-1',
      outcome: ToolConfirmationOutcome.ProceedOnce,
    });

    expect(session.getPendingApprovals().size).toBe(0);
    expect(respond).not.toHaveBeenCalled();
  });
});
