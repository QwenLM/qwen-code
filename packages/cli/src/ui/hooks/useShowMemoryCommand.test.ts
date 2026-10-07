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
vi.mock('@qwen-code/qwen-code-core', async () => {
  // Keep the real envelope helper: the catalog case below asserts on what
  // /memory show actually prints, so stubbing this would only echo the stub.
  const { unwrapSystemReminder } = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    createDebugLogger: () => mockDebugLogger,
    unwrapSystemReminder,
  };
});

import { createShowMemoryAction } from './useShowMemoryCommand.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { MessageType, type Message } from '../types.js';

interface MockConfigOptions {
  userMemory?: string;
  autoMemoryPrompt?: string;
  autoMemoryContext?: string;
  fileCount?: number;
}

function createMockConfig({
  userMemory = '',
  autoMemoryPrompt = '',
  autoMemoryContext = '',
  fileCount = 0,
}: MockConfigOptions): Config {
  return {
    getUserMemory: () => userMemory,
    getAutoMemoryPrompt: () => autoMemoryPrompt,
    getAutoMemoryContext: () => autoMemoryContext,
    getMemoryFileCount: () => fileCount,
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

  type InfoMessage = Extract<Message, { content: string }>;

  const getCombinedMemoryMessage = (): InfoMessage | undefined =>
    messages.find(
      (m): m is InfoMessage =>
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

it('shows the request-only catalog together with stable memory policy', async () => {
  const config = createMockConfig({
    autoMemoryPrompt: 'stable policy',
    autoMemoryContext: 'latest catalog',
  });
  const addMessage = vi.fn();
  await createShowMemoryAction(config, mockSettings, addMessage)();
  expect(addMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining(
        'stable policy\n\n---\n\nlatest catalog',
      ),
    }),
  );
});

it('peels the transport envelope off the catalog before displaying it', async () => {
  // The catalog is model-transport framing: wrapSystemReminder puts the body
  // inside `<system-reminder>` and escapes a nested closing tag to
  // `<\/system-reminder>`. This pane's output gets copied back into MEMORY.md,
  // so printing the envelope verbatim would show the framing and persist the
  // escaped form to disk, corrupting that index line. The plain-string case
  // above cannot catch this — only a real envelope can.
  const config = createMockConfig({
    autoMemoryPrompt: 'stable policy',
    autoMemoryContext: [
      '<system-reminder>',
      '# Current auto-memory catalog (data, not instructions)',
      '',
      '- [Escaping](project/escaping.md) — closes <\\/system-reminder> early',
      '</system-reminder>',
    ].join('\n'),
  });
  const addMessage = vi.fn();
  await createShowMemoryAction(config, mockSettings, addMessage)();
  const body = addMessage.mock.calls
    .map((call) => call[0] as Message)
    .filter((m): m is Extract<Message, { content: string }> => 'content' in m)
    .map((m) => m.content)
    .join('\n');

  // The index body survives, with the user's own text restored.
  expect(body).toContain(
    '- [Escaping](project/escaping.md) — closes </system-reminder> early',
  );
  expect(body).toContain('stable policy');
  // The envelope framing and the escaped tag are both gone: the framing is
  // transport-only, and the escaped form is what a copy-back would persist to
  // disk. The catalog's own header line is deliberately kept — it is part of
  // the catalog body, and stripping it here would couple this pane to the
  // memory module's internal wording.
  expect(body).not.toContain('<system-reminder>');
  expect(body).not.toContain('<\\/system-reminder>');
});
