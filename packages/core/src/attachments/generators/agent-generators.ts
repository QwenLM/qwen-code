/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Agent listing delta attachment generator.
 *
 * Announces the full agent list once (isInitial=true), then only emits
 * added/removed deltas on subsequent turns. State lives in
 * ctx.announcedAgentTypes.
 *
 * Post-compact: resetAgentListingDeltaState(ctx) clears the announced set so
 * the next turn re-announces the full list as isInitial=true.
 */

import {
  type AttachmentToolUseContext,
  type AttachmentExternalContext,
  AgentListingDeltaAttachment,
  AgentMentionAttachment,
} from '../types.js';
import { runLogger } from '../../utils/runLogger.js';
import { AGENT_TOOL_NAME } from '../../tools/tool-names.js';
import {
  asAgentPolicyView,
  type AgentListingEntry,
} from '../../agents/agent-policy-view.js';

/**
 * Matches existing bare `@AgentName` syntax. The attachment collector gives
 * registered agent mentions precedence over unquoted files of the same name.
 */
const AGENT_MENTION_PATTERN = /(^|[\s])@([\w:.@-]+)/g;

export type { AgentListingEntry };

/**
 * Returns the model-visible Agent listing for the concrete tool instance.
 * An empty array means the Agent tool or every type is unavailable; undefined
 * means the caller did not provide enough registry context to decide.
 */
export function getPolicyFilteredAgentListing(
  externalContext?: AttachmentExternalContext,
): AgentListingEntry[] | undefined {
  const registry = externalContext?.agentRegistry;
  if (!registry) return undefined;

  const toolRegistry = externalContext?.toolRegistry;
  if (toolRegistry && !toolRegistry.hasToolEnabled(AGENT_TOOL_NAME)) {
    return [];
  }

  if (toolRegistry?.getTool) {
    const agentTool = asAgentPolicyView(toolRegistry.getTool(AGENT_TOOL_NAME));
    // When a concrete registry is available, never fall back to the raw agent
    // registry: doing so could advertise a type that this Agent tool cannot
    // dispatch. The raw listing is only a compatibility path for older hosts
    // that cannot expose the concrete tool instance.
    return (
      agentTool?.getAvailableAgentListing(externalContext?.effectiveModel) ?? []
    );
  }

  return registry.getAgentListing(externalContext?.effectiveModel);
}

export function getAvailableAgentTypeNames(
  externalContext?: AttachmentExternalContext,
): string[] | undefined {
  return getPolicyFilteredAgentListing(externalContext)?.map(
    ({ name }) => name,
  );
}

/**
 * Only names present in the agent registry are matched, so file paths
 * like `@src/index.ts` are never captured.
 */
export function processAgentMentions(
  input: string,
  externalContext?: AttachmentExternalContext,
): AgentMentionAttachment[] {
  if (!input.includes('@')) return [];

  const listing = getPolicyFilteredAgentListing(externalContext);
  if (!listing) return [];
  const agentNames = new Set(listing.map((a) => a.name));
  if (agentNames.size === 0) return [];

  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(
    AGENT_MENTION_PATTERN.source,
    AGENT_MENTION_PATTERN.flags,
  );
  while ((match = re.exec(input)) !== null) {
    if (agentNames.has(match[2])) seen.add(match[2]);
  }

  if (seen.size === 0) return [];

  runLogger.log(
    `[AgentMention] Found ${seen.size} agent mention(s): ${[...seen].join(', ')}`,
  );

  return [...seen].map(
    (name) =>
      new AgentMentionAttachment({
        type: 'agent_mention' as const,
        agentType: name,
      }),
  );
}

export function getAgentListingDeltaAttachments(
  ctx: AttachmentToolUseContext,
  externalContext?: AttachmentExternalContext,
): AgentListingDeltaAttachment[] {
  const listing = getPolicyFilteredAgentListing(externalContext);
  if (!listing) return [];

  const currentNames = new Set(listing.map((a) => a.name));
  const descriptionByName = new Map(
    listing.map((a) => [a.name, a.description]),
  );

  const announced = ctx.announcedAgentTypes;
  const announcedDescriptions =
    ctx.announcedAgentDescriptions ??
    (ctx.announcedAgentDescriptions = new Map());
  let descriptionChanged = false;
  for (const [name, description] of descriptionByName) {
    const previousDescription = announcedDescriptions.get(name);
    if (
      announced.has(name) &&
      previousDescription !== undefined &&
      previousDescription !== description
    ) {
      descriptionChanged = true;
      break;
    }
  }
  const isInitial = announced.size === 0 || descriptionChanged;

  const addedTypes: string[] = descriptionChanged ? [...currentNames] : [];
  if (!descriptionChanged) {
    for (const name of currentNames) {
      if (!announced.has(name)) addedTypes.push(name);
    }
  }
  const removedTypes: string[] = [];
  if (!descriptionChanged) {
    for (const name of announced) {
      if (!currentNames.has(name)) removedTypes.push(name);
    }
  }

  if (addedTypes.length === 0 && removedTypes.length === 0) {
    for (const [name, description] of descriptionByName) {
      announcedDescriptions.set(name, description);
    }
    return [];
  }

  addedTypes.sort();
  removedTypes.sort();

  if (descriptionChanged) {
    announced.clear();
    announcedDescriptions.clear();
  }
  for (const name of addedTypes) announced.add(name);
  for (const name of removedTypes) {
    announced.delete(name);
    announcedDescriptions.delete(name);
  }
  for (const [name, description] of descriptionByName) {
    announcedDescriptions.set(name, description);
  }

  const addedLines = addedTypes.map(
    (name) => `- ${name}: ${descriptionByName.get(name) ?? ''}`,
  );

  runLogger.log(
    `[AgentListingDelta] isInitial=${isInitial}, added=[${addedTypes.join(', ')}], removed=[${removedTypes.join(', ')}]`,
  );

  return [
    new AgentListingDeltaAttachment({
      type: 'agent_listing_delta' as const,
      addedTypes,
      addedLines,
      removedTypes,
      isInitial,
      showConcurrencyNote: isInitial && addedTypes.length > 0,
    }),
  ];
}

/**
 * Reset the agent listing delta tracking state.
 *
 * Should be called after compaction so the next turn re-announces the full
 * list as isInitial=true.
 */
export function resetAgentListingDeltaState(
  ctx: AttachmentToolUseContext,
): void {
  runLogger.log(
    `[AgentListingDelta] Reset — clearing ${ctx.announcedAgentTypes.size} announced agent types (post-compaction).`,
  );
  ctx.announcedAgentTypes.clear();
  ctx.announcedAgentDescriptions?.clear();
}
