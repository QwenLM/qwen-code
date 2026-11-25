/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface ConversationUsage {
  readonly credits?: number;
  readonly contentLength?: number;
}

interface MeteringScope {
  readonly owner: object;
  readonly sessionId: string;
  readonly businessId?: string;
  readonly role?: 'main' | 'subagent';
}

interface UsageState {
  requests: Map<string, number>;
  contentLength?: number;
}

class ConversationMetering {
  private readonly sessions = new Map<string, Map<string, UsageState>>();

  ensure(
    sessionId: string,
    businessId: string,
  ): UsageState {
    let session = this.sessions.get(sessionId);
    if (!session)
      this.sessions.set(
        sessionId,
        (session = new Map()),
      );

    let state = session.get(businessId);
    if (!state)
      session.set(
        businessId,
        (state = { requests: new Map() }),
      );

    return state;
  }

  snapshot(sessionId: string): Array<[string, ConversationUsage]> {
    return [...(this.sessions.get(sessionId) ?? [])].map(([id, state]) => [
      id,
      {
        ...(state.requests.size
          ? { credits: [...state.requests.values()].reduce((a, b) => a + b, 0) }
          : {}),
        ...(state.contentLength !== undefined
          ? { contentLength: state.contentLength }
          : {}),
      },
    ]);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

const owners = new WeakMap<object, ConversationMetering>();
const scope = new AsyncLocalStorage<MeteringScope>();

/** 取消回调可能在其他异步上下文里执行，绑定时保留原会话的计量归属。 */
export function bindConversationMetering<T>(callback: () => T): () => T {
  const current = scope.getStore();
  return current ? () => scope.run(
    current,
    callback
  ) : callback;
}

/** 按运行时对象隔离计量状态，避免同名 session 的不同运行实例互相覆盖。 */
export function getConversationMetering(owner: object): ConversationMetering {
  let meter = owners.get(owner);
  if (!meter)
    owners.set(
      owner,
      (meter = new ConversationMetering()),
    );

  return meter;
}

/** 每次读取或关闭流时重新进入原归属，避免流式执行期间的费用记到其他会话。 */
export async function* withConversationMetering<T, R>(
  attribution: MeteringScope,
  create: () => AsyncGenerator<T, R>,
): AsyncGenerator<T, R> {
  const iterator = scope.run(
    attribution,
    create
  );
  let finished = false;

  try {
    while (true) {
      const next = await scope.run(
        attribution,
        () => iterator.next()
      );
      if (next.done) {
        finished = true;
        return next.value;
      }
      yield next.value;
    }
  } finally {
    if (!finished)
      await scope.run(
        attribution,
        () => iterator.return(undefined as R)
      );
  }
}

export function recordScopedCredits(
  sessionId: string,
  requestId: string,
  credits: number,
): void {
  const current = scope.getStore();
  if (!current?.role || !current.businessId || current.sessionId !== sessionId)
    return;
  const state = getConversationMetering(current.owner).ensure(
    sessionId,
    current.businessId,
  );

  // 同一个请求只累计一次费用；主代理和子代理的费用归入原业务会话。
  if (!state.requests.has(requestId))
    state.requests.set(
      requestId,
      credits,
    );
}

export function recordScopedInputTokens(tokens: number | undefined): void {
  const current = scope.getStore();
  if (
    current?.role !== 'main' ||
    !current.businessId ||
    typeof tokens !== 'number' ||
    !Number.isFinite(tokens) ||
    tokens < 0
  )
    return;
  // contentLength 取主代理最近一次有效输入 token 数，不累加子代理的上下文。
  getConversationMetering(current.owner).ensure(
    current.sessionId,
    current.businessId,
  ).contentLength = tokens;
}
