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

const snapshotSchema = z.object({
  workingDirectory: z.string(),
  isWorktree: z.boolean(),
  isGitRepo: z.boolean(),
  additionalWorkingDirectories: z.array(z.string()),
  platform: z.string(),
  shell: z.string(),
  osVersion: z.string(),
  architecture: z.string(),
  nodeVersion: z.string(),
});

const changeSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('workingDirectory'), from: z.string() }),
  z.object({ field: z.literal('isWorktree') }),
  z.object({ field: z.literal('isGitRepo') }),
  z.object({
    field: z.literal('additionalWorkingDirectories'),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
]);

export const environmentAttachmentSchema = z.object({
  type: z.literal('environment'),
  snapshot: snapshotSchema,
  changes: z.array(changeSchema).min(1).optional(),
});

export type EnvironmentSnapshot = z.infer<typeof snapshotSchema>;
export type EnvironmentChange = z.infer<typeof changeSchema>;

const WORKTREE_NOTICE =
  'This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT `cd` to the original repository root.';

export type EnvironmentMessage = AttachmentMessage & {
  attachment: EnvironmentAttachment;
};

export function isEnvironmentMessage(
  message: Message,
): message is EnvironmentMessage {
  return (
    message.type === 'attachment' && message.attachment.type === 'environment'
  );
}

function renderFull(snapshot: EnvironmentSnapshot): string[] {
  return [
    `Primary working directory: ${snapshot.workingDirectory}`,
    ...(snapshot.isWorktree ? [WORKTREE_NOTICE] : []),
    `Is a git repository: ${snapshot.isGitRepo}`,
    ...(snapshot.additionalWorkingDirectories.length > 0
      ? [
          `Additional working directories: ${snapshot.additionalWorkingDirectories.join(', ')}`,
        ]
      : []),
    `Platform: ${snapshot.platform}`,
    `Shell: ${snapshot.shell}`,
    `OS Version: ${snapshot.osVersion}`,
    `Architecture: ${snapshot.architecture}`,
    `Node.js version: ${snapshot.nodeVersion}`,
  ];
}

function renderChange(
  snapshot: EnvironmentSnapshot,
  change: EnvironmentChange,
): string[] {
  switch (change.field) {
    case 'workingDirectory':
      return [
        `Primary working directory: ${snapshot.workingDirectory} (was ${change.from})`,
      ];
    case 'isWorktree':
      return [
        snapshot.isWorktree
          ? WORKTREE_NOTICE
          : 'The primary working directory is no longer a git worktree.',
      ];
    case 'isGitRepo':
      return [
        `Is a git repository: ${snapshot.isGitRepo} (was ${!snapshot.isGitRepo})`,
      ];
    case 'additionalWorkingDirectories':
      return [
        ...(change.added.length > 0
          ? [`Additional working directories added: ${change.added.join(', ')}`]
          : []),
        ...(change.removed.length > 0
          ? [
              `Additional working directories removed: ${change.removed.join(', ')}`,
            ]
          : []),
      ];
    default:
      return [];
  }
}

/** A full snapshot is persisted even when only its changes are shown. */
export class EnvironmentAttachment extends BaseAttachment {
  readonly type = 'environment' as const;
  declare snapshot: EnvironmentSnapshot;
  declare changes?: EnvironmentChange[];

  constructor(data: AttachmentData<EnvironmentAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Historical or malformed payloads must neither break request projection
    // nor establish an announcement baseline that the model never received.
    const parsed = environmentAttachmentSchema.safeParse(this);
    if (!parsed.success) return [];
    const { snapshot, changes } = parsed.data;
    const lines = changes
      ? changes.flatMap((change) => renderChange(snapshot, change))
      : renderFull(snapshot);
    if (lines.length === 0) return [];
    return [
      systemReminder(
        [
          changes ? '# Environment update' : '# Environment',
          ...lines.map((line) => `- ${line}`),
        ].join('\n'),
      ),
    ];
  }
}
