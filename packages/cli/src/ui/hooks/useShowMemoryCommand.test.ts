/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDebugLogger } = vi.hoisted(() => ({
  mockDebugLogger: {
    isEnabled: vi.fn().mockReturnValue(false),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

import { createShowMemoryAction } from './useShowMemoryCommand.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { MessageType, type Message } from '../types.js';

interface MockConfigOptions {
  userMemory?: string;
  autoMemoryPrompt?: string;
  fileCount?: number;
}

function createMockConfig({
  userMemory = '',
  autoMemoryPrompt = '',
  fileCount = 0,
}: MockConfigOptions): Config {
  return {
    getUserMemory: () => userMemory,
    getAutoMemoryPrompt: () => autoMemoryPrompt,
    getGeminiMdFileCount: () => fileCount,
  } as unknown as Config;
}

const mockSettings = {
  merged: { context: { fileName: 'QWEN.md' } },
} as unknown as LoadedSettings;

describe('createShowMemoryAction', () => {
  let addMessage: (message: Message) => void;
  let messages: Message[];

  beforeEach(() => {
    messages = [];
    addMessage = vi.fn((message: Message) => {
      messages.push(message);
    });
  });

  const getCombinedMemoryMessage = (): Message | undefined =>
    messages.find(
      (m) =>
        m.type === MessageType.INFO &&
        m.content.startsWith('Current combined memory content:'),
    );

  it('joins the context and auto-memory layers with the section separator when both are non-empty', async () => {
    const config = createMockConfig({
      userMemory: '# Context\nProject convention.',
      autoMemoryPrompt: '# auto memory\nMEMORY.md index.',
      fileCount: 1,
    });

    await createShowMemoryAction(config, mockSettings, addMessage)();

    const combined = getCombinedMemoryMessage();
    expect(combined).toBeDefined();
    expect(combined!.content).toContain(
      '# Context\nProject convention.\n\n---\n\n# auto memory\nMEMORY.md index.',
    );
  });

  it('renders only the context layer without a separator when auto-memory is empty', async () => {
    const config = createMockConfig({
      userMemory: '# Context\nProject convention.',
      autoMemoryPrompt: '',
      fileCount: 1,
    });

    await createShowMemoryAction(config, mockSettings, addMessage)();

    const combined = getCombinedMemoryMessage();
    expect(combined).toBeDefined();
    expect(combined!.content).toContain('# Context\nProject convention.');
    expect(combined!.content).not.toContain('---');
  });

  it('renders only the auto-memory layer without a separator when context is empty', async () => {
    const config = createMockConfig({
      userMemory: '',
      autoMemoryPrompt: '# auto memory\nMEMORY.md index.',
      fileCount: 0,
    });

    await createShowMemoryAction(config, mockSettings, addMessage)();

    const combined = getCombinedMemoryMessage();
    expect(combined).toBeDefined();
    expect(combined!.content).toContain('# auto memory\nMEMORY.md index.');
    expect(combined!.content).not.toContain('---');
  });

  it('reports no memory (and emits no combined-content message) when both layers are empty', async () => {
    const config = createMockConfig({
      userMemory: '   \n\n  ',
      autoMemoryPrompt: '',
      fileCount: 0,
    });

    await createShowMemoryAction(config, mockSettings, addMessage)();

    expect(getCombinedMemoryMessage()).toBeUndefined();
    expect(
      messages.some(
        (m) =>
          m.type === MessageType.INFO &&
          m.content.includes('No hierarchical memory'),
      ),
    ).toBe(true);
  });
});
