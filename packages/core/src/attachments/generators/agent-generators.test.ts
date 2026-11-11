/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  getAgentListingDeltaAttachments,
  processAgentMentions,
} from './agent-generators.js';
import type {
  AttachmentToolUseContext,
  AttachmentExternalContext,
} from '../types.js';

function makeCtx(): AttachmentToolUseContext {
  return {
    isMainAgent: true,
    cwd: '/test',
    isFirstTurnSeedDone: false,
    loadedNestedMemoryPaths: new Set(),
    sentSkillNames: new Map(),
    pendingHookOutputs: [],
    pendingHookAttachments: [],
    postCompactCandidates: null,
    announcedMcpInstructionServers: new Set(),
    announcedLazyMcpTools: new Set(),
    announcedAgentTypes: new Set(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeExternalContext(
  listing: Array<{ name: string; description: string }>,
  isAgentToolEnabled: boolean,
): AttachmentExternalContext {
  return {
    toolRegistry: {
      hasToolEnabled: () => isAgentToolEnabled,
    },
    agentRegistry: {
      getAgentListing: () => listing,
    },
  };
}

describe('getAgentListingDeltaAttachments', () => {
  it('returns no listing when the Agent tool is disabled', () => {
    const ctx = makeCtx();

    const attachments = getAgentListingDeltaAttachments(
      ctx,
      makeExternalContext(
        [{ name: 'Explore', description: 'Explore the codebase' }],
        false,
      ),
    );

    expect(attachments).toEqual([]);
    expect(ctx.announcedAgentTypes.size).toBe(0);
  });

  it('returns no listing when no agent types are registered', () => {
    const ctx = makeCtx();

    const attachments = getAgentListingDeltaAttachments(
      ctx,
      makeExternalContext([], true),
    );

    expect(attachments).toEqual([]);
    expect(ctx.announcedAgentTypes.size).toBe(0);
  });

  it('emits the initial listing when the Agent tool is enabled', () => {
    const ctx = makeCtx();

    const attachments = getAgentListingDeltaAttachments(
      ctx,
      makeExternalContext(
        [{ name: 'Explore', description: 'Explore the codebase' }],
        true,
      ),
    );

    expect(attachments).toEqual([
      {
        type: 'agent_listing_delta',
        addedTypes: ['Explore'],
        addedLines: ['- Explore: Explore the codebase'],
        removedTypes: [],
        isInitial: true,
        showConcurrencyNote: true,
      },
    ]);
    expect([...ctx.announcedAgentTypes]).toEqual(['Explore']);
  });

  it('uses the concrete AgentTool policy-filtered listing when available', () => {
    const ctx = makeCtx();
    const externalContext = makeExternalContext(
      [
        { name: 'Explore', description: 'Explore the codebase' },
        { name: 'Plan', description: 'Plan a change' },
      ],
      true,
    );
    externalContext.toolRegistry!.getTool = () => ({
      getAvailableAgentListing: () => [
        { name: 'Plan', description: 'Plan a change' },
      ],
      isAgentTypeAvailable: (name: string) => name === 'Plan',
    });

    const attachments = getAgentListingDeltaAttachments(ctx, externalContext);

    expect(attachments[0]).toMatchObject({
      addedTypes: ['Plan'],
      addedLines: ['- Plan: Plan a change'],
    });
    expect([...ctx.announcedAgentTypes]).toEqual(['Plan']);
  });

  it('passes the effective model to the concrete Agent listing', () => {
    const ctx = makeCtx();
    const externalContext = makeExternalContext([], true);
    externalContext.effectiveModel = 'lean-model';
    const getAvailableAgentListing = vi.fn(() => [
      { name: 'Explore', description: 'Lean Explore description' },
    ]);
    externalContext.toolRegistry!.getTool = () => ({
      getAvailableAgentListing,
      isAgentTypeAvailable: () => true,
    });

    const attachments = getAgentListingDeltaAttachments(ctx, externalContext);

    expect(getAvailableAgentListing).toHaveBeenCalledWith('lean-model');
    expect(attachments[0]?.addedLines).toEqual([
      '- Explore: Lean Explore description',
    ]);
  });

  it('re-announces an Agent type when its Full/Lean description changes', () => {
    const ctx = makeCtx();
    let description = 'Full Explore description';
    const externalContext = makeExternalContext([], true);
    externalContext.toolRegistry!.getTool = () => ({
      getAvailableAgentListing: () => [{ name: 'Explore', description }],
      isAgentTypeAvailable: () => true,
    });
    getAgentListingDeltaAttachments(ctx, externalContext);

    description = 'Lean Explore description';
    const attachments = getAgentListingDeltaAttachments(ctx, externalContext);

    expect(attachments).toEqual([
      {
        type: 'agent_listing_delta',
        addedTypes: ['Explore'],
        addedLines: ['- Explore: Lean Explore description'],
        removedTypes: [],
        isInitial: true,
        showConcurrencyNote: true,
      },
    ]);
  });

  it('does not fall back to raw definitions when concrete Agent lookup fails', () => {
    const ctx = makeCtx();
    const externalContext = makeExternalContext(
      [{ name: 'Explore', description: 'Explore the codebase' }],
      true,
    );
    externalContext.toolRegistry!.getTool = () => undefined;

    expect(getAgentListingDeltaAttachments(ctx, externalContext)).toEqual([]);
    expect(ctx.announcedAgentTypes.size).toBe(0);
  });

  it('resolves @mentions only against policy-visible agent types', () => {
    const externalContext = makeExternalContext(
      [
        { name: 'Explore', description: 'Explore the codebase' },
        { name: 'Plan', description: 'Plan a change' },
      ],
      true,
    );
    externalContext.toolRegistry!.getTool = () => ({
      getAvailableAgentListing: () => [
        { name: 'Plan', description: 'Plan a change' },
      ],
      isAgentTypeAvailable: (name: string) => name === 'Plan',
    });

    expect(
      processAgentMentions('compare @Explore with @Plan', externalContext),
    ).toEqual([{ type: 'agent_mention', agentType: 'Plan' }]);
  });

  it('retracts announced types when the Agent tool becomes unavailable', () => {
    const ctx = makeCtx();
    getAgentListingDeltaAttachments(
      ctx,
      makeExternalContext(
        [{ name: 'Explore', description: 'Explore the codebase' }],
        true,
      ),
    );

    const attachments = getAgentListingDeltaAttachments(
      ctx,
      makeExternalContext(
        [{ name: 'Explore', description: 'Explore the codebase' }],
        false,
      ),
    );

    expect(attachments).toEqual([
      {
        type: 'agent_listing_delta',
        addedTypes: [],
        addedLines: [],
        removedTypes: ['Explore'],
        isInitial: false,
        showConcurrencyNote: false,
      },
    ]);
    expect(ctx.announcedAgentTypes.size).toBe(0);
  });
});
