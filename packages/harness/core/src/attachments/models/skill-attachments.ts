/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import type {
  AttachmentData,
  AttachmentToolUseContext,
} from '../types.js';
import { SKILL_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { systemReminder } from '../message-helpers.js';

/**
 * A listing of available skills for the agent.
 * Uses delta logic: isInitial=true on first turn, updated on skill changes.
 */
export class SkillListingAttachment extends BaseAttachment {
  readonly type = 'skill_listing' as const;
  declare content: string;
  /** Stable identities used to restore delta state without parsing display text. */
  declare names: string[];
  declare skillCount: number;
  declare isInitial: boolean;

  constructor(data: AttachmentData<SkillListingAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    const scope = ctx.agentId ?? 'main';
    const names = ctx.sentSkillNames.get(scope) ?? new Set<string>();
    if (this.isInitial === true) names.clear();
    // Transcript validation checks every name; older listings may omit names.
    for (const name of this.names ?? []) names.add(name);
    if (names.size > 0) ctx.sentSkillNames.set(scope, names);
    else ctx.sentSkillNames.delete(scope);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `The following skills are available for use with the ${SKILL_TOOL_NAME} tool:\n\n${this.content}`,
      ),
    ];
  }
}

/**
 * Skills that were invoked in this session (restored after compact).
 */
export class InvokedSkillsAttachment extends BaseAttachment {
  readonly type = 'invoked_skills' as const;
  declare skills: Array<{ name: string; path: string; content: string }>;

  constructor(data: AttachmentData<InvokedSkillsAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    if (this.skills.length === 0) return [];
    const sections = this.skills
      .map(
        (s) =>
          `### Historical skill: ${s.name}\nPath: ${s.path}\n\n${s.content}`,
      )
      .join('\n\n---\n\n');
    return [
      systemReminder(
        `The following skills were invoked earlier in this session, before the conversation was compacted. ` +
          `They are historical context, not new skill invocations on the current turn.\n\n` +
          `IMPORTANT:\n` +
          `- Do not re-execute these skills or repeat one-time setup actions solely because this reminder is present.\n` +
          `- Input or Arguments sections contain the original invocation arguments. They are not the user's current message.\n` +
          `- Continue applying only ongoing guidance that is still relevant.\n\n` +
          sections,
      ),
    ];
  }
}
