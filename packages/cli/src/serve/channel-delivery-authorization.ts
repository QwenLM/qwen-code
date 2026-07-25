/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ChannelDeliveryAuthorizationTarget {
  channelName: string;
  type: 'user' | 'chat';
  id: string;
}

interface PromptAuthorization {
  sessionId: string;
  deliveryId: string;
  target: ChannelDeliveryAuthorizationTarget;
}

interface ScheduledTaskAuthorization {
  sessionId: string;
  taskId: string;
  target: ChannelDeliveryAuthorizationTarget;
  recurring: boolean;
  lastConsumedAt: number;
}

interface DeliveryAuthorizationRequest {
  sessionId: string;
  deliveryId: string;
  source: 'prompt' | 'scheduled';
  target: ChannelDeliveryAuthorizationTarget;
  promptId?: string;
  taskId?: string;
  firedAt?: number;
}

function authorizationKey(
  workspaceCwd: string,
  sessionId: string,
  id: string,
): string {
  return JSON.stringify([workspaceCwd, sessionId, id]);
}

function targetsEqual(
  left: ChannelDeliveryAuthorizationTarget,
  right: ChannelDeliveryAuthorizationTarget,
): boolean {
  return (
    left.channelName === right.channelName &&
    left.type === right.type &&
    left.id === right.id
  );
}

export class ChannelDeliveryAuthorizationStore {
  readonly #prompts = new Map<string, ChannelDeliveryAuthorizationTarget>();
  readonly #scheduledTasks = new Map<string, ScheduledTaskAuthorization>();

  authorizePrompt(
    workspaceCwd: string,
    authorization: PromptAuthorization,
  ): void {
    this.#prompts.set(
      authorizationKey(
        workspaceCwd,
        authorization.sessionId,
        authorization.deliveryId,
      ),
      authorization.target,
    );
  }

  revokePrompt(
    workspaceCwd: string,
    sessionId: string,
    deliveryId: string,
  ): void {
    this.#prompts.delete(authorizationKey(workspaceCwd, sessionId, deliveryId));
  }

  registerScheduledTask(
    workspaceCwd: string,
    authorization: Omit<ScheduledTaskAuthorization, 'lastConsumedAt'> & {
      lastFiredAt?: number;
    },
  ): void {
    const key = authorizationKey(
      workspaceCwd,
      authorization.sessionId,
      authorization.taskId,
    );
    const current = this.#scheduledTasks.get(key);
    this.#scheduledTasks.set(key, {
      sessionId: authorization.sessionId,
      taskId: authorization.taskId,
      target: authorization.target,
      recurring: authorization.recurring,
      lastConsumedAt: current?.lastConsumedAt ?? authorization.lastFiredAt ?? 0,
    });
  }

  revokeScheduledTask(
    workspaceCwd: string,
    sessionId: string,
    taskId: string,
  ): void {
    this.#scheduledTasks.delete(
      authorizationKey(workspaceCwd, sessionId, taskId),
    );
  }

  consume(
    workspaceCwd: string,
    request: DeliveryAuthorizationRequest,
  ): boolean {
    if (request.source === 'prompt') {
      if (request.promptId !== request.deliveryId) return false;
      const key = authorizationKey(
        workspaceCwd,
        request.sessionId,
        request.deliveryId,
      );
      const target = this.#prompts.get(key);
      if (!target || !targetsEqual(target, request.target)) return false;
      this.#prompts.delete(key);
      return true;
    }

    if (
      typeof request.taskId !== 'string' ||
      typeof request.firedAt !== 'number' ||
      request.deliveryId !== `${request.taskId}:${request.firedAt}`
    ) {
      return false;
    }
    const key = authorizationKey(
      workspaceCwd,
      request.sessionId,
      request.taskId,
    );
    const authorization = this.#scheduledTasks.get(key);
    if (
      !authorization ||
      request.firedAt <= authorization.lastConsumedAt ||
      !targetsEqual(authorization.target, request.target)
    ) {
      return false;
    }
    if (authorization.recurring) {
      authorization.lastConsumedAt = request.firedAt;
    } else {
      this.#scheduledTasks.delete(key);
    }
    return true;
  }
}
