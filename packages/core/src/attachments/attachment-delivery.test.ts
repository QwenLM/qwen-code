/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@qwen-code/resource';
import {
  createAttachmentContext,
  getAttachmentMessages,
} from './get-attachments.js';
import { createAttachmentMessage } from './factory.js';
import { snapshotAttachmentDeltaState } from './transcript-state.js';
import { getSkillListingAttachments } from './generators/skill-generators.js';
import { getLazyMcpReminderAttachments } from './generators/mcp-lazy-generator.js';
import { getAgentListingDeltaAttachments } from './generators/agent-generators.js';
import { McpLazyToolsDeltaAttachment } from './models/mcp-attachments.js';
import { sha1 } from '../utils/paths.js';

const skill = (name: string): SkillDefinition => ({
  name,
  description: name,
  body: name,
  location: `/skills/${name}/SKILL.md`,
  skillRoot: `/skills/${name}`,
});
const external = (names: string[]) => ({
  mcpClientManager: {
    getConnectedServerInstructions: () => [],
    getLazyMcpServerSnapshot: () => [{ serverName: 'files', toolNames: names }],
  },
});

describe('partial attachment delivery rollback', () => {
  it.each([true, false])(
    'keeps delivered Skill names and fingerprints, retries only undelivered MCP (workflows=%s)',
    async (preserveNames) => {
      const ctx = createAttachmentContext('/workspace');
      const restore = snapshotAttachmentDeltaState(ctx);
      const [listing] = await getSkillListingAttachments(
        ctx,
        [skill('alpha')],
        true,
        { preserveNames },
      );
      getLazyMcpReminderAttachments(ctx, external(['mcp__files__read']));
      restore([createAttachmentMessage(listing)]);
      expect([...ctx.sentSkillNames.get('main')!]).toEqual(['alpha']);
      expect(ctx.sentSkillListingFingerprints?.get('main')).toBe(
        sha1(`full\u0000${listing.content}`),
      );
      expect(ctx.announcedLazyMcpTools.size).toBe(0);
      expect(
        await getSkillListingAttachments(ctx, [skill('alpha')], true, {
          preserveNames,
        }),
      ).toEqual([]);
      expect(
        getLazyMcpReminderAttachments(ctx, external(['mcp__files__read'])),
      ).toHaveLength(1);
      expect(
        getLazyMcpReminderAttachments(ctx, external(['mcp__files__read'])),
      ).toEqual([]);
    },
  );

  it.each([true, false])(
    'commits queued Skill full without losing a later undelivered delta (workflows=%s)',
    async (preserveNames) => {
      const ctx = createAttachmentContext('/workspace');
      const [full] = await getSkillListingAttachments(
        ctx,
        [skill('alpha')],
        true,
        { preserveNames },
      );
      ctx.pendingPostCompactDeltaAttachments = [full];
      const restore = snapshotAttachmentDeltaState(ctx);
      ctx.pendingPostCompactDeltaAttachments = null;
      const [delta] = await getSkillListingAttachments(
        ctx,
        [skill('alpha'), skill('beta')],
        false,
        { preserveNames },
      );
      expect(delta.names).toEqual(['beta']);
      restore([createAttachmentMessage(full)]);
      expect(ctx.pendingPostCompactDeltaAttachments).toBeNull();
      expect([...ctx.sentSkillNames.get('main')!]).toEqual(['alpha']);
      const retried = await getSkillListingAttachments(
        ctx,
        [skill('alpha'), skill('beta')],
        false,
        { preserveNames },
      );
      expect(retried.map((a) => a.names)).toEqual([['beta']]);
      expect(
        await getSkillListingAttachments(
          ctx,
          [skill('alpha'), skill('beta')],
          false,
          { preserveNames },
        ),
      ).toEqual([]);
    },
  );

  it('removes only delivered deferred occurrences and keeps the remaining queue ordered', () => {
    const ctx = createAttachmentContext('/workspace');
    const queued = new McpLazyToolsDeltaAttachment({
      type: 'mcp_lazy_tools_delta',
      content: 'catalog',
      isInitial: true,
      addedNames: ['mcp__files__read'],
      removedNames: [],
    });
    ctx.pendingPostCompactDeltaAttachments = [queued, queued];
    const restore = snapshotAttachmentDeltaState(ctx);
    ctx.pendingPostCompactDeltaAttachments = null;
    restore([createAttachmentMessage(queued)]);
    expect(ctx.pendingPostCompactDeltaAttachments).toEqual([queued]);
    expect([...ctx.announcedLazyMcpTools]).toEqual(['mcp__files__read']);
  });

  it('retries the fresh MCP delta after its queued full was delivered', async () => {
    const ctx = createAttachmentContext('/workspace');
    const names = Array.from({ length: 30 }, (_, i) => `mcp__files__tool_${i}`);
    const [full] = getLazyMcpReminderAttachments(ctx, external(names));
    ctx.pendingPostCompactDeltaAttachments = [full];
    const restore = snapshotAttachmentDeltaState(ctx);
    const added = [...names, 'mcp__files__search'];
    const batch = await getAttachmentMessages(
      'hello',
      ctx,
      [],
      null,
      { skipSkillDiscovery: true },
      external(added),
    );
    const catalogs = batch.filter(
      (m) => m.attachment.type === 'mcp_lazy_tools_delta',
    );
    expect(catalogs).toHaveLength(2);
    restore([catalogs[0]]);
    expect(ctx.pendingPostCompactDeltaAttachments).toBeNull();
    const retry = getLazyMcpReminderAttachments(ctx, external(added));
    expect(retry).toMatchObject([
      { isInitial: false, addedNames: ['mcp__files__search'] },
    ]);
    expect(getLazyMcpReminderAttachments(ctx, external(added))).toEqual([]);
  });

  it.each([false, true])(
    'preserves agent descriptions from the delivered version (fresh delivered=%s)',
    (deliverFresh) => {
      const ctx = createAttachmentContext('/workspace');
      let description = 'old';
      const registry = {
        agentRegistry: {
          getAgentListing: () => [{ name: 'explore', description }],
        },
      };
      const [full] = getAgentListingDeltaAttachments(ctx, registry);
      ctx.pendingPostCompactDeltaAttachments = [full];
      const restore = snapshotAttachmentDeltaState(ctx);
      ctx.pendingPostCompactDeltaAttachments = null;
      description = 'new';
      const [fresh] = getAgentListingDeltaAttachments(ctx, registry);
      restore(
        [full, ...(deliverFresh ? [fresh] : [])].map(createAttachmentMessage),
      );
      expect(ctx.announcedAgentDescriptions?.get('explore')).toBe(
        deliverFresh ? 'new' : 'old',
      );
      expect(getAgentListingDeltaAttachments(ctx, registry)).toHaveLength(
        deliverFresh ? 0 : 1,
      );
    },
  );
});
