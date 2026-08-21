/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionOwnerSnapshot } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';

export interface TranscriptUserMessageIdentity {
  block: DaemonTranscriptBlock;
}

export interface TranscriptTurnErrorIdentity {
  block: DaemonTranscriptBlock;
}

export interface CancelledRetryOwner {
  sessionId?: string;
  workspaceCwd?: string;
  sessionKey?: string;
  sourceVersion: number;
  snapshot: DaemonSessionOwnerSnapshot;
}

export interface FailedPromptRetry {
  sessionId: string;
  messageId: string;
  startedAt: number;
  admitted: boolean;
  settled: boolean;
  owner: CancelledRetryOwner;
  transcriptIdentity:
    | { kind: 'failed-prompt'; identity: TranscriptUserMessageIdentity }
    | { kind: 'turn-error'; identity: TranscriptTurnErrorIdentity };
}

export type PromptAdmissionFailureKind =
  | 'rejected'
  | 'unknown'
  | 'after-admission';

export class PromptAdmissionAttempt {
  private started = false;
  private admitted = false;

  constructor(private readonly ownerIsCurrent: () => boolean = () => true) {}

  markStarted(): void {
    this.started = true;
  }

  markAdmitted(): void {
    this.admitted = true;
  }

  isCurrent(): boolean {
    return this.ownerIsCurrent();
  }

  classifyFailure(definitelyRejected: boolean): PromptAdmissionFailureKind {
    if (this.admitted) return 'after-admission';
    if (this.started && !definitelyRejected) return 'unknown';
    return 'rejected';
  }
}

export function retryOwnerMatchesCurrent(
  owner: CancelledRetryOwner,
  sessionId: string | undefined,
  workspaceCwd: string | undefined,
  sourceVersion: number,
): boolean {
  const workspaceMatches =
    (owner.workspaceCwd !== undefined && owner.workspaceCwd === workspaceCwd) ||
    owner.snapshot.isCurrent();
  return (
    owner.sessionId === sessionId &&
    owner.sourceVersion === sourceVersion &&
    workspaceMatches
  );
}

export function getLatestUserBlockId(
  blocks: readonly DaemonTranscriptBlock[],
): string | undefined {
  return getLatestUserBlock(blocks)?.id;
}

export function getLatestUserBlock(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTranscriptBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      block?.kind === 'user' &&
      block.meta?.['source'] !== 'background_notification'
    ) {
      return block;
    }
  }
  return undefined;
}

export function matchesUserMessageIdentity(
  block: DaemonTranscriptBlock | undefined,
  identity: TranscriptUserMessageIdentity | undefined,
  allowLocalId = false,
): boolean {
  if (!identity) return block === undefined;
  if (!block || block.kind !== 'user' || identity.block.kind !== 'user') {
    return false;
  }
  if (block === identity.block) return true;
  if (allowLocalId && block.id === identity.block.id) return true;
  const expectedRecords = identity.block.sourceRecordIds;
  const currentRecords = block.sourceRecordIds;
  return (
    expectedRecords !== undefined &&
    expectedRecords.length > 0 &&
    currentRecords !== undefined &&
    currentRecords.length === expectedRecords.length &&
    currentRecords.every((record, index) => record === expectedRecords[index])
  );
}

export function findUserMessageByIdentity(
  blocks: readonly DaemonTranscriptBlock[],
  identity: TranscriptUserMessageIdentity,
  allowLocalId = false,
): DaemonTranscriptBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      block?.kind === 'user' &&
      block.meta?.['source'] !== 'background_notification' &&
      matchesUserMessageIdentity(block, identity, allowLocalId)
    ) {
      return block;
    }
  }
  return undefined;
}

export function getRetryableTurnError(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTranscriptBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block?.kind === 'user') {
      if (block.meta?.['source'] === 'background_notification') continue;
      break;
    }
    if (block?.kind === 'error' && block.source === 'turn_error') return block;
    if (block?.kind !== 'debug') break;
  }
  return undefined;
}

export function matchesTurnErrorIdentity(
  block: DaemonTranscriptBlock | undefined,
  identity: TranscriptTurnErrorIdentity,
): boolean {
  if (
    !block ||
    block.kind !== 'error' ||
    block.source !== 'turn_error' ||
    identity.block.kind !== 'error' ||
    identity.block.source !== 'turn_error'
  ) {
    return false;
  }
  if (block === identity.block) return true;
  const expectedPromptId = identity.block.promptId;
  if (expectedPromptId) return block.promptId === expectedPromptId;
  return (
    identity.block.eventId !== undefined &&
    block.eventId === identity.block.eventId
  );
}

export function retryTranscriptIdentityMatches(
  blocks: readonly DaemonTranscriptBlock[],
  transcriptIdentity: FailedPromptRetry['transcriptIdentity'],
  allowLocalUserId = false,
): boolean {
  return transcriptIdentity.kind === 'failed-prompt'
    ? matchesUserMessageIdentity(
        getLatestUserBlock(blocks),
        transcriptIdentity.identity,
        allowLocalUserId,
      )
    : matchesTurnErrorIdentity(
        getRetryableTurnError(blocks),
        transcriptIdentity.identity,
      );
}
