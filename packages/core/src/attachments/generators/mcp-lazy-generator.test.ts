/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getLazyMcpReminderAttachments,
  resetLazyMcpReminderState,
} from './mcp-lazy-generator.js';
import { createAttachmentContext } from '../get-attachments.js';
import type { AttachmentExternalContext } from '../types.js';
import type { LazyMcpServerSnapshot } from '../../tools/mcp-lazy/tool-list-text.js';

function external(
  getSnapshot: () => LazyMcpServerSnapshot[] | null,
): AttachmentExternalContext {
  return {
    mcpClientManager: {
      getConnectedServerInstructions: () => [],
      getLazyMcpServerSnapshot: getSnapshot,
    },
  };
}

function server(name: string, tools: string[]): LazyMcpServerSnapshot {
  return {
    serverName: name,
    toolNames: tools.map((tool) => `mcp__${name}__${tool}`),
  };
}

describe('getLazyMcpReminderAttachments', () => {
  it.each([true, false])(
    'uses the agent registry discovery mode for both catalogs and deltas (CodeMode=%s)',
    (codeMode) => {
      const ctx = createAttachmentContext('/test', 's');
      let snapshot = [server('a', ['x'])];
      const ext = external(() => snapshot);
      ext.toolRegistry = {
        hasToolEnabled: () => true,
        getCodeModeExposure: () => (codeMode ? 'on' : undefined),
      };

      const [catalog] = getLazyMcpReminderAttachments(ctx, ext);
      expect(catalog.isInitial).toBe(true);
      expect(catalog.content).toContain(codeMode ? 'searchTools' : 'mcp_list');
      expect(getLazyMcpReminderAttachments(ctx, ext)).toEqual([]);

      snapshot = [server('a', ['x', 'y'])];
      const [delta] = getLazyMcpReminderAttachments(ctx, ext);
      expect(delta.isInitial).toBe(false);
      expect(delta.addedNames).toEqual(['mcp__a__y']);
      expect(delta.content).toContain(codeMode ? 'tools[name](args)' : 'mcp_call');
      if (codeMode) {
        expect(catalog.content).not.toMatch(/mcp_list|mcp_get|mcp_call/);
        expect(delta.content).not.toMatch(/mcp_list|mcp_get|mcp_call/);
      }
    },
  );

  it('stays silent without a manager or when lazy mode is off', () => {
    const ctx = createAttachmentContext('/test', 's');
    expect(getLazyMcpReminderAttachments(ctx, {})).toEqual([]);
    expect(getLazyMcpReminderAttachments(ctx, external(() => null))).toEqual(
      [],
    );
    expect(ctx.announcedLazyMcpTools.size).toBe(0);
  });

  it('sends the full catalog once, then nothing while the catalog is unchanged', () => {
    const ctx = createAttachmentContext('/test', 's');
    const ext = external(() => [server('a', ['x', 'y']), server('b', ['z'])]);

    const [first] = getLazyMcpReminderAttachments(ctx, ext);
    expect(first.type).toBe('mcp_lazy_tools_delta');
    expect(first.isInitial).toBe(true);
    expect(first.addedNames).toEqual(['mcp__a__x', 'mcp__a__y', 'mcp__b__z']);
    expect(first.content).toContain('## MCP servers');
    expect(JSON.stringify(first.toUserMessages())).toContain(
      '<system-reminder>',
    );
    expect([...ctx.announcedLazyMcpTools].sort()).toEqual(first.addedNames);

    expect(getLazyMcpReminderAttachments(ctx, ext)).toEqual([]);
    expect(getLazyMcpReminderAttachments(ctx, ext)).toEqual([]);
  });

  it('announces only the added and removed tools afterwards', () => {
    const ctx = createAttachmentContext('/test', 's');
    let snapshot = [server('a', ['x']), server('b', ['z'])];
    const ext = external(() => snapshot);
    getLazyMcpReminderAttachments(ctx, ext);

    snapshot = [server('a', ['x', 'w'])];
    const [delta] = getLazyMcpReminderAttachments(ctx, ext);
    expect(delta.isInitial).toBe(false);
    expect(delta.addedNames).toEqual(['mcp__a__w']);
    expect(delta.removedNames).toEqual(['mcp__b__z']);
    expect(delta.content).toContain('MCP tool catalog update');
    expect(delta.content).toContain('mcp__a__w');
    expect(delta.content).toContain('`mcp__b__*`');
    expect(delta.content).not.toContain('## MCP servers');
    expect([...ctx.announcedLazyMcpTools].sort()).toEqual([
      'mcp__a__w',
      'mcp__a__x',
    ]);
  });

  it('retracts every tool when all servers disappear', () => {
    const ctx = createAttachmentContext('/test', 's');
    let snapshot = [server('code', ['x'])];
    const ext = external(() => snapshot);
    getLazyMcpReminderAttachments(ctx, ext);

    snapshot = [];
    const [delta] = getLazyMcpReminderAttachments(ctx, ext);
    expect(delta.isInitial).toBe(false);
    expect(delta.removedNames).toEqual(['mcp__code__x']);
    expect(delta.content).toContain('No MCP servers are connected right now');
    expect(ctx.announcedLazyMcpTools.size).toBe(0);
    expect(getLazyMcpReminderAttachments(ctx, ext)).toEqual([]);
  });

  it('falls back to the full catalog when the delta would be longer', () => {
    const ctx = createAttachmentContext('/test', 's');
    for (let i = 0; i < 200; i++)
      ctx.announcedLazyMcpTools.add(`mcp__a__retired_operation_${i}`);
    const [attachment] = getLazyMcpReminderAttachments(
      ctx,
      external(() => [server('a', ['x'])]),
    );
    expect(attachment.isInitial).toBe(true);
    expect(attachment.addedNames).toEqual(['mcp__a__x']);
    expect(attachment.removedNames).toEqual([]);
    expect([...ctx.announcedLazyMcpTools]).toEqual(['mcp__a__x']);
  });

  it('re-sends the full catalog after the announced set is reset', () => {
    const ctx = createAttachmentContext('/test', 's');
    const ext = external(() => [server('a', ['x'])]);
    getLazyMcpReminderAttachments(ctx, ext);

    resetLazyMcpReminderState(ctx);
    expect(ctx.announcedLazyMcpTools.size).toBe(0);
    const [again] = getLazyMcpReminderAttachments(ctx, ext);
    expect(again.isInitial).toBe(true);
    expect(() =>
      resetLazyMcpReminderState(createAttachmentContext('/t', 's')),
    ).not.toThrow();
  });
});
