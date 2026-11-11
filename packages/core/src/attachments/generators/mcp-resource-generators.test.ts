/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import { processMcpResourceMentions } from './mcp-resource-generators.js';

function setup() {
  const resources = [
    { name: 'Schema', uri: 'doc://schema', serverName: 'docs' },
    { name: 'Versioned schema', uri: 'doc://schema?rev=1&format=json', serverName: 'docs' },
    { name: 'Empty parameter', uri: 'doc://schema?rev=', serverName: 'docs' },
    { name: 'Broken', uri: 'doc://broken', serverName: 'docs' },
  ] as Array<Resource & { serverName: string }>;
  const readResource = vi.fn(
    async (
      _server: string,
      uri: string,
      _signal: AbortSignal,
    ): Promise<ReadResourceResult | undefined> => ({
      contents: [{ uri, text: `content of ${uri}` }],
    }),
  );
  const source = {
    findResource: (identifier: string) => {
      const colonIndex = identifier.indexOf(':');
      if (colonIndex <= 0) return undefined;
      const serverName = identifier.substring(0, colonIndex);
      const uri = identifier.substring(colonIndex + 1);
      return resources.find(
        (resource) => resource.serverName === serverName && resource.uri === uri,
      );
    },
    canUseServer: vi.fn(() => true),
    readResource,
  };
  return { resources, source, readResource, context: { mcpResources: source } };
}

afterEach(() => vi.useRealTimers());

describe('processMcpResourceMentions', () => {
  it('requires explicit host opt-in', async () => {
    expect(await processMcpResourceMentions('@docs:doc://schema')).toEqual([]);
  });

  it('reads each exact resource once, preserving the entire URI', async () => {
    const { context, readResource } = setup();
    const attachments = await processMcpResourceMentions(
      '@docs:doc://schema?rev=1&format=json @docs:doc://schema?rev=1&format=json @docs:doc://schema?rev=',
      context,
    );
    expect(readResource.mock.calls.map((call) => call[1])).toEqual([
      'doc://schema?rev=1&format=json',
      'doc://schema?rev=',
    ]);
    expect(attachments.map((a) => a.uri)).toEqual([
      'doc://schema?rev=1&format=json',
      'doc://schema?rev=',
    ]);
  });

  it('does not downgrade an unknown URI to a registered base URI', async () => {
    const { context, readResource } = setup();
    expect(
      await processMcpResourceMentions(
        '@docs:doc://schema?rev=2 @other:doc://schema',
        context,
      ),
    ).toEqual([]);
    expect(readResource).not.toHaveBeenCalled();
  });

  it('ignores embedded and escaped mentions', async () => {
    const { context, readResource } = setup();
    expect(
      await processMcpResourceMentions(
        String.raw`x@docs:doc://schema \@docs:doc://schema`,
        context,
      ),
    ).toEqual([]);
    expect(readResource).not.toHaveBeenCalled();
  });

  it('checks server permission before reading', async () => {
    const { context, source, readResource } = setup();
    source.canUseServer.mockReturnValue(false);
    expect(
      await processMcpResourceMentions('@docs:doc://schema', context),
    ).toEqual([]);
    expect(readResource).not.toHaveBeenCalled();
  });

  it('preserves successes when another resource fails or has no client', async () => {
    const { context, readResource } = setup();
    readResource.mockRejectedValueOnce(new Error('read failed'));
    readResource.mockResolvedValueOnce(undefined);
    const attachments = await processMcpResourceMentions(
      '@docs:doc://broken @docs:doc://schema?rev= @docs:doc://schema',
      context,
    );
    expect(attachments).toEqual([
      expect.objectContaining({ server: 'docs', uri: 'doc://schema' }),
    ]);
  });

  it('keeps server identities distinct for the same URI', async () => {
    const { resources, context, readResource } = setup();
    resources.push({
      name: 'Other schema',
      uri: 'doc://schema',
      serverName: 'other',
    } as (typeof resources)[number]);
    const attachments = await processMcpResourceMentions(
      '@docs:doc://schema @other:doc://schema',
      context,
    );
    expect(readResource).toHaveBeenCalledTimes(2);
    expect(attachments.map((a) => a.server)).toEqual(['docs', 'other']);
  });

  it('aborts timed-out reads while preserving successful resources', async () => {
    vi.useFakeTimers();
    const { context, readResource } = setup();
    readResource.mockImplementationOnce(() => new Promise(() => {}));
    const result = processMcpResourceMentions(
      '@docs:doc://broken @docs:doc://schema',
      context,
    );
    const readSignal = readResource.mock.calls[0][2];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readSignal.aborted).toBe(true);
    expect(await result).toEqual([
      expect.objectContaining({ uri: 'doc://schema' }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates turn cancellation and aborts the active read', async () => {
    const { context, readResource } = setup();
    const controller = new AbortController();
    readResource.mockImplementationOnce(() => new Promise(() => {}));
    const result = processMcpResourceMentions(
      '@docs:doc://schema',
      context,
      controller.signal,
    );
    const readSignal = readResource.mock.calls[0][2];
    const error = new Error('turn cancelled');
    controller.abort(error);
    await expect(result).rejects.toBe(error);
    expect(readSignal.aborted).toBe(true);
  });

  it('does not read after cancellation', async () => {
    const { context, readResource } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      processMcpResourceMentions(
        '@docs:doc://schema',
        context,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(readResource).not.toHaveBeenCalled();
  });
});
