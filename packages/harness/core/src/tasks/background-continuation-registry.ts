/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { TaskRegistry } from './task-registry.js';

/** 后台结果已生成但尚未消费时，继续保留原业务会话，避免提前上报结束。 */
export class BackgroundContinuationRegistry {
  private readonly records = new Map<
    string,
    { sessionId: string; businessId: string; owner?: object }
  >();

  /** owner 使用当前 Config 的稳定身份，供运行时销毁时清理自身记录。 */
  register(
    sessionId: string,
    businessId: string,
    owner?: object
  ): string {
    const id = randomUUID();
    this.records.set(
      id,
      { sessionId, businessId, owner }
    );
    return id;
  }

  consume(recordIds: readonly string[]): void {
    for (const id of recordIds) this.records.delete(id);
  }

  discard(recordIds: readonly string[]): void {
    this.consume(recordIds);
  }

  isPending(
    sessionId: string,
    businessId: string
  ): boolean {
    return [...this.records.values()].some(
      (record) =>
        record.sessionId === sessionId && record.businessId === businessId,
    );
  }

  clearSession(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(id);
    }
  }

  /** 旧实例销毁时只清理自身，不能误删同一 session 新实例的待消费结果。 */
  clearOwner(owner: object): void {
    for (const [id, record] of this.records) {
      if (record.owner === owner) this.records.delete(id);
    }
  }
}

export const backgroundContinuationRegistry =
  new BackgroundContinuationRegistry();

export function hasUnfinishedBackgroundWork(
  taskRegistry: TaskRegistry | undefined,
  sessionId: string,
  businessId: string,
): boolean {
  // 任务还在运行，或结果通知尚未消费，都意味着原业务会话还不能收尾。
  return (
    (taskRegistry?.hasUnfinishedBackgroundTasks(
      sessionId,
      businessId
    ) ??
      false) ||
    backgroundContinuationRegistry.isPending(
      sessionId,
      businessId
    )
  );
}
