/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import {
  getAgentixActiveTurn,
  readAgentixMemorySnapshot,
  withAgentixMemoryContext,
} from './agentixMemoryContext.js';

const mockFiles = new Map<string, string>();

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn((filePath: string) => mockFiles.has(filePath)),
    readFileSync: vi.fn((filePath: string) => {
      const contents = mockFiles.get(filePath);
      if (contents === undefined) {
        throw new Error('File not found');
      }
      return contents;
    }),
  },
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({ warn: vi.fn() }),
}));

describe('Agentix memory context', () => {
  beforeEach(() => {
    mockFiles.clear();
    vi.stubEnv('QWEN_MEMORY_SNAPSHOT_DIR', '/test/memory-snapshots');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when no snapshot exists', () => {
    expect(readAgentixMemorySnapshot('session-1')).toBeNull();
  });

  it('preserves complete curated history for zero-state conversations', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Earlier request.' }] },
      { role: 'model', parts: [{ text: 'Earlier response.' }] },
      { role: 'user', parts: [{ text: 'Current request.' }] },
    ];

    const outbound = withAgentixMemoryContext(contents, 'new-session');

    expect(outbound).toEqual(contents);
    expect(outbound).not.toBe(contents);
  });

  it('normalizes snapshot formatting and rejects unsafe session IDs', () => {
    mockFiles.set(
      '/test/memory-snapshots/session-1.md',
      '# Heading\n**Metadata**\nRemember this.\n---\n',
    );

    expect(readAgentixMemorySnapshot('session-1')).toBe('Remember this.');
    expect(readAgentixMemorySnapshot('../session-1')).toBeNull();
  });

  it('bounds the amount of snapshot context sent to the model', () => {
    vi.stubEnv('QWEN_MEMORY_SNAPSHOT_MAX_CHARS', '8');
    mockFiles.set('/test/memory-snapshots/session-1.md', '1234567890');

    expect(readAgentixMemorySnapshot('session-1')).toBe('12345678');
  });

  it('adds snapshot context without mutating or duplicating history', () => {
    mockFiles.set(
      '/test/memory-snapshots/session-1.md',
      'Remember this repository.',
    );
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Continue.' }] },
    ];

    const withMemory = withAgentixMemoryContext(contents, 'session-1');
    expect(withMemory).toHaveLength(2);
    expect(withMemory[0]?.parts?.[0]?.text).toContain(
      'Remember this repository.',
    );
    expect(contents).toHaveLength(1);

    const withoutDuplicate = withAgentixMemoryContext(withMemory, 'session-1');
    expect(withoutDuplicate).toEqual(withMemory);
  });

  it('replaces completed conversation turns with the snapshot', () => {
    mockFiles.set('/test/memory-snapshots/session-1.md', 'Long-term memory.');
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Old request.' }] },
      { role: 'model', parts: [{ text: 'Old response.' }] },
      { role: 'user', parts: [{ text: 'Current request.' }] },
    ];

    const outbound = withAgentixMemoryContext(contents, 'session-1');

    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.parts?.[0]?.text).toContain('Long-term memory.');
    expect(outbound[1]).toEqual(contents[2]);
  });

  it('preserves the current tool exchange but drops prior completed turns', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Old request.' }] },
      { role: 'model', parts: [{ text: 'Old response.' }] },
      { role: 'user', parts: [{ text: 'Fix the file.' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'contents' },
            },
          },
        ],
      },
    ];

    expect(getAgentixActiveTurn(contents)).toEqual(contents.slice(2));
  });
});
