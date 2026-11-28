/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MCPServerStatus, type Config } from '@qwen-code/core';
import { createMcpResourceAttachmentSource } from './mcpResourceAttachments.js';

describe('createMcpResourceAttachmentSource', () => {
  it('uses the live session manager, server policy, and client with cancellation', async () => {
    const readResource = vi.fn(async () => ({ contents: [] }));
    const getClient = vi.fn(() => ({
      readResource,
      getStatus: () => MCPServerStatus.CONNECTED,
    }));
    const findResourceByUri = vi.fn();
    const canUseMcpServer = vi.fn(() => false);
    const config = {
      getMcpClientManager: () => ({
        findResourceByUri,
        getClient,
        canUseMcpServer,
      }),
    } as unknown as Config;
    const source = createMcpResourceAttachmentSource(config);
    source.findResource('docs:doc://schema?rev=1');
    expect(findResourceByUri).toHaveBeenCalledWith('docs:doc://schema?rev=1');
    expect(source.canUseServer('docs')).toBe(false);
    expect(canUseMcpServer).toHaveBeenCalledWith('docs');
    const signal = new AbortController().signal;
    await source.readResource('docs', 'doc://schema?rev=1', signal);
    expect(getClient).toHaveBeenCalledWith('docs');
    expect(readResource).toHaveBeenCalledWith('doc://schema?rev=1', { signal });
  });

  it.each([
    MCPServerStatus.CONNECTING,
    MCPServerStatus.DISCONNECTED,
  ])(
    'skips resources on a %s client without issuing a read',
    async (status) => {
      const readResource = vi.fn();
      const source = createMcpResourceAttachmentSource({
        getMcpClientManager: () => ({
          getClient: () => ({ getStatus: () => status, readResource }),
        }),
      } as unknown as Config);
      expect(
        await source.readResource(
          'docs',
          'doc://schema',
          new AbortController().signal,
        ),
      ).toBeUndefined();
      expect(readResource).not.toHaveBeenCalled();
    },
  );

  it('skips resources when their client is unavailable', async () => {
    const source = createMcpResourceAttachmentSource({
      getMcpClientManager: () => ({ getClient: () => undefined }),
    } as unknown as Config);
    expect(
      await source.readResource(
        'docs',
        'doc://schema',
        new AbortController().signal,
      ),
    ).toBeUndefined();
  });
});
