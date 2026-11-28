/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSameBusiness,
  type BusinessInfo,
} from '../../qoder/business-info.js';
import type {
  HookAfterResult,
  HookBeforeResult,
  HookCoordinatorAdapter,
} from '../../core/hook-coordinator-types.js';
import type { HookAttachment } from '../../attachments/types.js';
import { NoopHookCoordinator } from '../../hooks/coordinators.js';
import type { HookSystem } from '../../hooks/hookSystem.js';
import { runLogger } from '../../utils/runLogger.js';
import { formatTeammateMessage } from './agent-team-peer-message.js';
import {
  markTeamMessageRead,
  readTeamInbox,
  type TeamMailboxMessage,
} from './agent-team-runtime.js';

export interface AgentTeamHookCoordinatorOptions {
  businessInfo?: Readonly<BusinessInfo>;
  teamName: string;
  memberName: string;
  hookSystem?: Pick<HookSystem, 'fireTeammateIdleEvent'>;
  pollIntervalMs?: number;
  injectAfterTurn?: boolean;
  pollInbox?: boolean;
}

const TEAMMATE_IDLE_HOOK_FEEDBACK_PREFIX = 'TeammateIdle hook feedback:\n';

function mergePendingAttachments(
  current: HookAttachment[] | undefined,
  incoming: HookAttachment[] | undefined,
): HookAttachment[] | undefined {
  const merged = [...(current ?? []), ...(incoming ?? [])];
  return merged.length > 0 ? merged : undefined;
}

export class AgentTeamHookCoordinator implements HookCoordinatorAdapter {
  private pendingMessages: TeamMailboxMessage[] = [];
  private readonly seenMessageIds = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private disposed = false;

  constructor(
    private readonly inner: HookCoordinatorAdapter,
    private readonly options: AgentTeamHookCoordinatorOptions,
  ) {}

  start(): void {
    if (this.options.pollInbox === false) return;
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => {
      void this.pollNow();
    }, this.options.pollIntervalMs ?? 1000);
    this.pollTimer.unref?.();
  }

  async pollNow(): Promise<void> {
    if (this.options.pollInbox === false) return;
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const messages = await readTeamInbox({
        teamName: this.options.teamName,
        memberName: this.options.memberName,
        unreadOnly: true,
      });
      const unseen = messages.filter(
        (message) =>
          !this.seenMessageIds.has(message.id) &&
          (!message.businessInfo ||
            isSameBusiness(message.businessInfo, this.options.businessInfo)),
      );
      if (unseen.length > 0) {
        for (const message of unseen) {
          this.seenMessageIds.add(message.id);
        }
        this.pendingMessages.push(...unseen);
      }
    } catch (error) {
      runLogger.warn(
        `[AgentTeamHookCoordinator] Failed to read inbox for team "${this.options.teamName}" member "${this.options.memberName}":`,
        error,
      );
    } finally {
      this.polling = false;
    }
  }

  async fireBefore(
    promptId: string,
    prompt: string,
    imageUrls?: readonly string[],
    requestSetId?: string,
  ): Promise<HookBeforeResult | null> {
    const result = await this.inner.fireBefore(
      promptId,
      prompt,
      imageUrls,
      requestSetId,
    );
    await this.pollNow();
    return result;
  }

  async fireAfter(
    promptId: string,
    prompt: string,
    response: string,
    options?: Parameters<HookCoordinatorAdapter['fireAfter']>[3],
  ): Promise<HookAfterResult | null> {
    const result = await this.inner.fireAfter(
      promptId,
      prompt,
      response,
      options,
    );
    if (result?.stopped || result?.blocked || result?.inject) {
      return result;
    }

    if (this.options.injectAfterTurn !== false) {
      await this.pollNow();
      const mailboxContext = await this.drainMailboxContext();
      if (mailboxContext) {
        return {
          ...(result ?? {}),
          inject: mailboxContext,
        };
      }
    }

    return this.fireTeammateIdleHook(result);
  }

  private async fireTeammateIdleHook(
    result: HookAfterResult | null,
  ): Promise<HookAfterResult | null> {
    const hookSystem = this.options.hookSystem;
    if (!hookSystem) return result;

    const aggregated = await hookSystem.fireTeammateIdleEvent(
      this.options.memberName,
      this.options.teamName,
    );
    const hookOutput = aggregated.finalOutput;
    const pendingAttachments = mergePendingAttachments(
      result?.pendingAttachments,
      aggregated.pendingAttachments,
    );

    if (hookOutput?.shouldStopExecution() || hookOutput?.isBlockingDecision()) {
      const feedback =
        hookOutput.modelInjection || hookOutput.getEffectiveReason();
      return {
        ...(result ?? {}),
        blocked: true,
        inject: `${TEAMMATE_IDLE_HOOK_FEEDBACK_PREFIX}${feedback}`,
        retryAsStopHook: true,
        systemMessage: hookOutput.systemMessage ?? result?.systemMessage,
        additionalContext:
          hookOutput.getAdditionalContext() ?? result?.additionalContext,
        suppressOutput:
          hookOutput.suppressOutput || result?.suppressOutput || undefined,
        pendingAttachments,
      };
    }

    if (pendingAttachments) {
      return {
        ...(result ?? {}),
        pendingAttachments,
      };
    }
    return result;
  }

  drainPendingAsyncContext(): string | undefined {
    const innerContext = this.inner.drainPendingAsyncContext();
    const mailboxContext = this.takeMailboxContext();
    if (innerContext && mailboxContext) {
      return `${innerContext}\n\n${mailboxContext}`;
    }
    return innerContext ?? mailboxContext;
  }

  private takeMailboxContext(): string | undefined {
    if (this.pendingMessages.length === 0) return undefined;
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    void this.markMessagesRead(messages);
    return formatTeamMailboxMessages(messages);
  }

  private async drainMailboxContext(): Promise<string | undefined> {
    if (this.pendingMessages.length === 0) return undefined;
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    await this.markMessagesRead(messages);
    return formatTeamMailboxMessages(messages);
  }

  private async markMessagesRead(
    messages: TeamMailboxMessage[],
  ): Promise<void> {
    await Promise.all(
      messages.map(async (message) => {
        try {
          await markTeamMessageRead({
            teamName: this.options.teamName,
            memberName: this.options.memberName,
            messageId: message.id,
          });
        } catch (error) {
          this.seenMessageIds.delete(message.id);
          runLogger.warn(
            `[AgentTeamHookCoordinator] Failed to mark mailbox message "${message.id}" as read:`,
            error,
          );
        }
      }),
    );
  }

  async fireStopFailure(
    errorType: Parameters<HookCoordinatorAdapter['fireStopFailure']>[0],
    options?: Parameters<HookCoordinatorAdapter['fireStopFailure']>[1],
  ): Promise<void> {
    await this.inner.fireStopFailure(errorType, options);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.inner.dispose();
  }
}

export function createAgentTeamHookCoordinator(
  inner: HookCoordinatorAdapter | undefined,
  options: AgentTeamHookCoordinatorOptions,
): AgentTeamHookCoordinator {
  const coordinator = new AgentTeamHookCoordinator(
    inner ?? new NoopHookCoordinator(),
    options,
  );
  coordinator.start();
  return coordinator;
}

export function formatTeamMailboxMessages(
  messages: TeamMailboxMessage[],
): string {
  return messages
    .map((message) =>
      formatTeammateMessage({
        from: message.from,
        text: message.text,
        summary: message.summary,
        color: message.color,
      }),
    )
    .join('\n\n');
}
