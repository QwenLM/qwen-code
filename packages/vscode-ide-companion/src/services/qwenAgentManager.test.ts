/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), showErrorMessage: vi.fn() },
  workspace: {},
  commands: { executeCommand: vi.fn() },
}));

describe('QwenAgentManager JSONL message reconstruction', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('restores thinking parts as separate thinking messages', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-agent-manager-'));
    cleanup.push(tempDir);
    const sessionPath = path.join(tempDir, 'session.jsonl');

    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-03-06T12:00:00.000Z',
          message: { parts: [{ text: 'hello' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-03-06T12:00:01.000Z',
          message: {
            parts: [
              { text: 'thinking step', thought: true },
              { text: 'final answer' },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const { QwenAgentManager } = await import('./qwenAgentManager.js');
    const manager = new QwenAgentManager();
    const messages = await (manager as unknown as {
      readJsonlMessages(filePath: string): Promise<Array<{ role: string; content: string }>>;
    }).readJsonlMessages(sessionPath);

    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
      expect.objectContaining({ role: 'thinking', content: 'thinking step' }),
      expect.objectContaining({ role: 'assistant', content: 'final answer' }),
    ]);
  });
});
