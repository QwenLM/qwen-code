/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { applyNameDelta } from '../restore-context-helpers.js';
import { sha1 } from '../../utils/paths.js';
import type {
  AttachmentData,
  AttachmentToolUseContext,
} from '../types.js';
import { AGENT_TOOL_NAME } from '../../tools/tool-names.js';
import { systemReminder } from '../message-helpers.js';
import type { SubagentProgressEntry } from '../types.js';

/**
 * @agent mention in user input.
 * Emitted when user types @agent-type in their prompt.
 */
export class AgentMentionAttachment extends BaseAttachment {
  readonly type = 'agent_mention' as const;
  declare agentType: string;

  constructor(data: AttachmentData<AgentMentionAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `The user has expressed a desire to invoke the agent "${this.agentType}". Please invoke the agent appropriately, passing in the required context to it.`,
      ),
    ];
  }
}

/**
 * @-mention of a live peer session in user input.
 *
 * Emitted only for a human-typed TUI prompt. `status: 'resolved'` carries the
 * one label to address; `'ask'` carries up to three that the name could mean.
 * Every string here has been vetted and proved to resolve — see
 * `messaging/peer-mention.ts`.
 */
export class PeerMentionAttachment extends BaseAttachment {
  readonly type = 'peer_mention' as const;
  /** The token the user typed, unescaped. */
  declare mention: string;
  declare status: 'resolved' | 'ask';
  /**
   * Options to hand the model; one when resolved, ≤3 when ask.
   *
   * `detail` carries the sanitized facts that tell same-named sessions apart,
   * and is empty on the resolved path.
   */
  declare candidates: Array<{ label: string; detail: string }>;
  /** Total matches; exceeds `candidates.length` when truncated. */
  declare total: number;

  constructor(data: AttachmentData<PeerMentionAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Every label here was proved to resolve, and every string rendered comes
    // from `candidates` or `mention`, both vetted in messaging/peer-mention.ts.
    // Nothing else a peer controls — its title, cwd or status — is
    // interpolated into this block.
    if (this.status === 'resolved') {
      const label = this.candidates[0].label;
      return [
        systemReminder(
          `The user @-mentioned the session "${label}" as @${this.mention}. ` +
            `If their message asks you to tell or ask that session something, use ` +
            `the SendMessage tool with to: "${label}" — that exact label. Do not ` +
            `message it unless the user's message actually asks you to; a mention ` +
            `on its own is a reference, not an instruction to send.`,
        ),
      ];
    }

    // One option per line, each with the facts that tell it from its
    // namesakes — a working directory is what makes "which one did you mean"
    // answerable, where two opaque labels are not.
    const options = this.candidates
      .map(({ label, detail }) =>
        detail ? `- "${label}" (${detail})` : `- "${label}"`,
      )
      .join('\n');
    const overflow =
      this.total > this.candidates.length
        ? ` (${this.total} sessions answer to that name; showing ${this.candidates.length})`
        : '';
    return [
      systemReminder(
        `The user @-mentioned @${this.mention}, which matches more than ` +
          `one live session${overflow}. Ask the user which one they meant before ` +
          `sending anything — session names are self-chosen and unverified, so do ` +
          `not guess between them. Once they choose, address it with SendMessage ` +
          `using that option's exact label:\n${options}`,
      ),
    ];
  }
}

/**
 * Delta notification of available agent types.
 * isInitial=true after compact (full re-announcement).
 */
export class AgentListingDeltaAttachment extends BaseAttachment {
  readonly type = 'agent_listing_delta' as const;
  declare addedTypes: string[];
  declare addedLines: string[];
  declare removedTypes: string[];
  declare isInitial: boolean;
  declare showConcurrencyNote: boolean;

  constructor(data: AttachmentData<AgentListingDeltaAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    if (this.isInitial === true) ctx.announcedAgentTypes.clear();
    applyNameDelta(ctx.announcedAgentTypes, this.addedTypes, this.removedTypes);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    if (this.addedTypes.length === 0 && this.removedTypes.length === 0)
      return [];
    const lines: string[] = [];
    if (this.isInitial) {
      lines.push(`Available agent types for the ${AGENT_TOOL_NAME} tool:`);
      lines.push(...this.addedLines);
    } else {
      if (this.addedTypes.length > 0) {
        lines.push(`New agent types available: ${this.addedTypes.join(', ')}`);
        lines.push(...this.addedLines);
      }
      if (this.removedTypes.length > 0) {
        lines.push(
          `Agent types no longer available: ${this.removedTypes.join(', ')}`,
        );
      }
    }
    if (this.showConcurrencyNote) {
      lines.push('Note: Multiple agents can run concurrently.');
    }
    return [systemReminder(lines.join('\n'))];
  }
}

/**
 * Live team context: all running/completed subagents and their activity.
 * Uses delta logic (hash-based).
 */
export class TeamContextAttachment extends BaseAttachment {
  readonly type = 'team_context' as const;
  declare agents: SubagentProgressEntry[];

  constructor(data: AttachmentData<TeamContextAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    if (Array.isArray(this.agents)) {
      ctx.lastSubagentHash = sha1(JSON.stringify(this.agents));
    }
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    if (this.agents.length === 0) return [];
    const agentLines = this.agents
      .map((a) => `${a.agentName} [${a.state ?? 'unknown'}]`)
      .join('\n');
    return [systemReminder(`<team_context>\n${agentLines}\n</team_context>`)];
  }
}
