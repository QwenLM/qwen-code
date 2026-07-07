/**
 * Unit tests for query() option mapping
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QueryOptions } from '../../src/query/createQuery.js';

const mockProcessTransport = vi.fn();
const mockQuery = vi.fn();
const mockPrepareSpawnInfo = vi.fn();

vi.mock('../../src/transport/ProcessTransport.js', () => ({
  ProcessTransport: mockProcessTransport,
}));

vi.mock('../../src/query/Query.js', () => ({
  Query: mockQuery,
}));

vi.mock('../../src/utils/cliPath.js', () => ({
  prepareSpawnInfo: mockPrepareSpawnInfo,
}));

describe('query()', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockPrepareSpawnInfo.mockReturnValue(undefined);
    mockProcessTransport.mockImplementation(() => ({
      write: vi.fn(),
      readMessages: vi.fn(),
      close: vi.fn(),
      waitForExit: vi.fn(),
      endInput: vi.fn(),
      exitError: null,
    }));
    mockQuery.mockImplementation(() => ({
      initialized: Promise.resolve(),
      getSessionId: () => 'test-session-id',
      streamInput: vi.fn(),
    }));
  });

  it('maps string systemPrompt to TransportOptions.systemPrompt', async () => {
    const { query } = await import('../../src/query/createQuery.js');

    query({
      prompt: 'hello',
      options: {
        systemPrompt: 'You are a strict reviewer.',
      } satisfies QueryOptions,
    });

    expect(mockProcessTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'You are a strict reviewer.',
      }),
    );
  });

  it('maps preset systemPrompt append to TransportOptions.appendSystemPrompt', async () => {
    const { query } = await import('../../src/query/createQuery.js');

    query({
      prompt: 'hello',
      options: {
        systemPrompt: {
          type: 'preset',
          preset: 'qwen_code',
          append: 'Be terse.',
        },
      } satisfies QueryOptions,
    });

    const transportOptions = mockProcessTransport.mock.calls[0]?.[0];

    expect(transportOptions.appendSystemPrompt).toBe('Be terse.');
    expect(transportOptions.systemPrompt).toBeUndefined();
  });

  it('rejects non-qwen preset names at runtime validation', async () => {
    const { query } = await import('../../src/query/createQuery.js');

    expect(() =>
      query({
        prompt: 'hello',
        options: {
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: 'Be terse.',
          } as never,
        } satisfies QueryOptions,
      }),
    ).toThrow(/systemPrompt/);
  });
});
