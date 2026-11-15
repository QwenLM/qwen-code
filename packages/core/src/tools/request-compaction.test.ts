/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { describe, expect, it, vi } from 'vitest';
import { RequestCompactionTool } from './request-compaction.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

function configWithChat(requestModelCompaction?: ReturnType<typeof vi.fn>) {
  const chat = { requestModelCompaction };
  const llmClient = { getChat: () => chat };
  return {
    getLlmClient: vi.fn().mockReturnValue(llmClient),
  } as unknown as Config;
}

describe('RequestCompactionTool', () => {
  it('names and registers under the tool registry constants', () => {
    expect(RequestCompactionTool.Name).toBe(ToolNames.REQUEST_COMPACTION);
    expect(ToolDisplayNames.REQUEST_COMPACTION).toBe('RequestCompaction');
  });

  it('marks the chat for a model-requested compaction at the next round', async () => {
    const requestModelCompaction = vi.fn();
    const tool = new RequestCompactionTool(
      configWithChat(requestModelCompaction),
    );
    const result = await tool.buildAndExecute(
      {} as never,
      new AbortController().signal,
    );
    expect(requestModelCompaction).toHaveBeenCalledOnce();
    expect(result.llmContent).toContain('Compaction scheduled');
    expect(result.llmContent).toContain('next model round');
  });

  it('degrades to an error message without an active chat', async () => {
    const tool = new RequestCompactionTool({
      getLlmClient: vi.fn().mockReturnValue(undefined),
    } as unknown as Config);
    const result = await tool.buildAndExecute(
      {} as never,
      new AbortController().signal,
    );
    expect(result.llmContent).toContain('No active chat session.');
  });
});
