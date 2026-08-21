/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resumeCommand } from './resumeCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

vi.mock('../../config/config.js', () => ({
  isValidSessionId: vi.fn((value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  ),
}));

const mockIsAgentViewWorkerResumeCommandBlocked = vi.hoisted(() =>
  vi.fn(() => false),
);
const mockIsManagedAgentViewResumeBlocked = vi.hoisted(() =>
  vi.fn(async () => false),
);

vi.mock('../../startup/agent-view-resume-guard.js', () => ({
  AGENT_VIEW_WORKER_RESUME_MESSAGE:
    'Resume is disabled inside an attached background agent. Detach to `qwen agents` and use `/resume` there.',
  isAgentViewWorkerResumeCommandBlocked:
    mockIsAgentViewWorkerResumeCommandBlocked,
  isManagedAgentViewResumeBlocked: mockIsManagedAgentViewResumeBlocked,
  MANAGED_AGENT_VIEW_RESUME_MESSAGE: 'managed session message',
}));

describe('resumeCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAgentViewWorkerResumeCommandBlocked.mockReturnValue(false);
    mockContext = createMockCommandContext();
  });

  it('should have the correct name and description', () => {
    expect(resumeCommand.name).toBe('resume');
    expect(resumeCommand.description).toBe('Resume a previous session');
  });

  it('should have "continue" as an alias', () => {
    expect(resumeCommand.altNames).toContain('continue');
  });

  it('should return dialog action when no args provided', async () => {
    const result = await resumeCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'resume',
    });
  });

  it('blocks resume inside an attached background agent', async () => {
    mockIsAgentViewWorkerResumeCommandBlocked.mockReturnValue(true);

    const result = await resumeCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Resume is disabled inside an attached background agent. Detach to `qwen agents` and use `/resume` there.',
    });
  });

  it('should return error when config is not available and args given', async () => {
    mockContext.services.config = null;

    const result = await resumeCommand.action!(mockContext, 'some-arg');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config is not available.',
    });
  });

  it('should resume directly when valid UUID is provided and session exists', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const mockConfig = {
      getSessionService: vi.fn().mockReturnValue({
        sessionExists: vi.fn().mockResolvedValue(true),
      }),
      getTargetDir: vi.fn().mockReturnValue('/test'),
    };

    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await resumeCommand.action!(mockContext, sessionId);

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'resume',
      sessionId,
    });
  });

  it('blocks direct resume for a managed Agent View session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    mockIsManagedAgentViewResumeBlocked.mockResolvedValueOnce(true);
    const sessionExists = vi.fn().mockResolvedValue(true);
    const mockConfig = {
      getSessionService: vi.fn().mockReturnValue({ sessionExists }),
      getTargetDir: vi.fn().mockReturnValue('/test'),
    };
    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await resumeCommand.action!(mockContext, sessionId);

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'managed session message',
    });
    expect(sessionExists).toHaveBeenCalledWith(sessionId);
  });

  it('should return error when valid UUID is provided but session does not exist', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const mockConfig = {
      getSessionService: vi.fn().mockReturnValue({
        sessionExists: vi.fn().mockResolvedValue(false),
      }),
      getTargetDir: vi.fn().mockReturnValue('/test'),
    };

    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await resumeCommand.action!(mockContext, sessionId);

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: `No session found with ID "${sessionId}".`,
    });
  });

  it('should resume directly when custom title has single match', async () => {
    const matchedSessionId = '550e8400-e29b-41d4-a716-446655440000';

    const mockConfig = {
      getSessionService: vi.fn().mockReturnValue({
        sessionExists: vi.fn().mockResolvedValue(false),
        findSessionsByTitle: vi
          .fn()
          .mockResolvedValue([{ sessionId: matchedSessionId }]),
      }),
    };

    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await resumeCommand.action!(mockContext, 'my-feature');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'resume',
      sessionId: matchedSessionId,
    });
  });

  it('should show picker when custom title has multiple matches', async () => {
    const mockConfig = {
      getSessionService: vi.fn().mockReturnValue({
        sessionExists: vi.fn().mockResolvedValue(false),
        findSessionsByTitle: vi
          .fn()
          .mockResolvedValue([{ sessionId: 'id-1' }, { sessionId: 'id-2' }]),
      }),
    };

    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await resumeCommand.action!(mockContext, 'shared-name');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'resume',
      matchedSessions: [{ sessionId: 'id-1' }, { sessionId: 'id-2' }],
    });
  });

  it('should return error when custom title has no matches', async () => {
    const mockConfig = {
      getSessionService: vi.fn().mockReturnValue({
        sessionExists: vi.fn().mockResolvedValue(false),
        findSessionsByTitle: vi.fn().mockResolvedValue([]),
      }),
    };

    mockContext = createMockCommandContext({
      services: { config: mockConfig as never },
    });

    const result = await resumeCommand.action!(mockContext, 'nonexistent');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'No session found with title "nonexistent".',
    });
  });
});
