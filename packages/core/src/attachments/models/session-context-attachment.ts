/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { BaseAttachment } from './base-attachment.js';
import { systemReminder } from '../message-helpers.js';
import type { AttachmentData } from '../types.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import type {
  AttachmentMessage,
  Message,
} from '../../protocol/transcript/message.js';

export const SESSION_CONTEXT_FIELDS = [
  'userEmail',
  'attachedProject',
  'gitStatus',
  'perforceMode',
] as const;

export const sessionContextSchema = z.record(
  z.enum(SESSION_CONTEXT_FIELDS),
  z.string(),
);
export type SessionContext = z.infer<typeof sessionContextSchema>;

const reasonText = {
  session_start: 'when this session started',
  compaction: 'after the conversation was compacted',
  policy_refresh: "after the organization's managed settings changed",
  managed_folder_check: "after a check of this machine's managed folder",
  directory_added: 'after a working directory was added',
  settings_sync: 'after settings were synced onto this machine',
  account_change: 'after the account changed',
  hooks_invalidate: 'after a plugin had the context re-read',
  policy_verdict: "after the organization's policy arrived",
  project_reread: 'after an earlier read of the attached project failed',
  memory_paused: 'after memory was paused for this session',
  memory_resumed: 'after memory was resumed for this session',
  auto_memory_off: 'after auto-memory was turned off for this session',
  auto_memory_back_on: 'after auto-memory was turned back on for this session',
} as const;
export type SessionContextReason = keyof typeof reasonText;
const reasonSchema = z.enum(
  Object.keys(reasonText) as [SessionContextReason, ...SessionContextReason[]],
);

/** Current non-Git values; Git keeps its independent retained-snapshot policy. */
export interface SessionContextInput {
  context: Omit<SessionContext, 'gitStatus'>;
  reason?: SessionContextReason;
}

export const sessionContextAttachmentSchema = z.object({
  type: z.literal('session_context'),
  context: sessionContextSchema,
  // Unknown metadata from another version must not hide a readable context.
  changed: z.boolean().optional().catch(undefined),
  reason: reasonSchema.optional().catch(undefined),
});

export type SessionContextMessage = AttachmentMessage & {
  attachment: SessionContextAttachment;
};

export function isSessionContextMessage(
  message: Message,
): message is SessionContextMessage {
  return (
    message.type === 'attachment' &&
    message.attachment.type === 'session_context'
  );
}

/** An empty context also records that Git was omitted or unavailable. */
export class SessionContextAttachment extends BaseAttachment {
  readonly type = 'session_context' as const;
  declare context: SessionContext;
  declare changed?: boolean;
  declare reason?: SessionContextReason;

  constructor(data: AttachmentData<SessionContextAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const parsed = sessionContextAttachmentSchema.safeParse(this);
    if (!parsed.success) return [];
    const { context, changed, reason } = parsed.data;
    const sections = SESSION_CONTEXT_FIELDS.flatMap((field) =>
      context[field] ? [`# ${field}\n${context[field]}`] : [],
    );
    const when = reason ? ` ${reasonText[reason]}` : '';
    if (sections.length === 0) {
      return changed
        ? [
            systemReminder(
              `The session context was re-read${when}; the values announced earlier (account, project, git status) no longer apply.`,
            ),
          ]
        : [];
    }
    const introduction = changed
      ? reason
        ? `The session context was re-read${when}; these values replace the earlier ones:`
        : 'The session context has changed; these values replace the earlier ones:'
      : "As you answer the user's questions, you can use the following context:";
    return [
      systemReminder(
        `${introduction}\n${sections.join('\n')}\n\n` +
          "This context was attached automatically; it is not part of the user's message. " +
          "It describes the user's workspace, so it does not need to be reported back.",
      ),
    ];
  }
}
