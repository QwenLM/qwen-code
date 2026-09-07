/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { SessionSourceService } from '../services/session-sources.js';
import { RecordSourceTool } from './record-source.js';

function tool(persist = vi.fn(async () => undefined)) {
  const service = new SessionSourceService({
    sessionId: 'test',
    workspaceCwd: () => '/workspace',
    load: async () => ({}),
    persist,
  });
  const config = { getSessionSourceService: () => service } as Config;
  return { tool: new RecordSourceTool(config), service, persist };
}

const input = {
  title: 'Reference',
  locator: {
    type: 'workspace_file' as const,
    workspacePath: 'does-not-need-to-exist.md',
  },
};

describe('record_source', () => {
  it('acknowledges the persisted source ID without reading the file or creating an artifact', async () => {
    const { tool: sourceTool, persist, service } = tool();
    const result = await sourceTool
      .build(input)
      .execute(AbortSignal.timeout(1000));
    const source = (await service.list()).sources[0]!;
    expect(persist).toHaveBeenCalledOnce();
    expect(result.llmContent).toBe(`Reference added: ${source.id}`);
    expect(result.artifacts).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('returns an ordinary tool error when persistence fails and does not claim registration succeeded', async () => {
    const { tool: sourceTool, service } = tool(
      vi.fn(async () => {
        throw new Error('disk full');
      }),
    );
    const result = await sourceTool
      .build(input)
      .execute(AbortSignal.timeout(1000));
    expect(result.error?.message).toBe(
      'Source metadata could not be persisted',
    );
    expect(result.llmContent).not.toContain('Reference added');
    expect((await service.list()).sources).toEqual([]);
  });

  it('rejects attachment locators, unknown input fields and invalid URLs before execution', () => {
    const { tool: sourceTool } = tool();
    for (const value of [
      {
        title: 'Upload',
        locator: { type: 'attachment' as const, attachmentId: 'id' },
      },
      { ...input, workspaceCwd: '/other' },
      {
        title: 'Secret',
        locator: {
          type: 'url' as const,
          url: 'https://name:password@example.com',
        },
      },
    ])
      expect(sourceTool.validateToolParams(value)).not.toBeNull();
  });
});
