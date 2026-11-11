/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话生命周期阶段耗时日志：包裹 open 与首轮的每个阶段，在 init 帧与首 token
 * 两个边界输出汇总，用于回答「慢在哪一段」。
 * 仅写 run 日志，不进协议帧，也不改变执行顺序与错误语义。
 */

import { runLogger } from '@qwen-code/core';

export interface SessionPhaseRecord {
  /** 阶段名，中文且稳定：外部可能拿它做日志切分，不要随意改词。 */
  readonly name: string;
  /** 这一步做了什么，一句话。 */
  readonly work: string;
  readonly durationMs: number;
  readonly status?: 'resolved' | 'rejected';
}

export class SessionPhaseLog {
  private readonly records: SessionPhaseRecord[] = [];
  private readonly receivedAt = Date.now();

  constructor(private readonly sessionId: string) {}

  /**
   * 包裹一段异步工作：记耗时、立即打一行、原样返回或抛出。
   *
   * 阶段名用中文是接入方要求的（他们的排查面板按中文阶段名切分）；`work` 写这一步
   * **做了什么**而不是怎么做，因为日志的读者要的是「这 3 秒花在哪件事上」。
   */
  async phase<T>(
    name: string,
    work: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    this.start(name, work);
    let status: 'resolved' | 'rejected' = 'rejected';
    try {
      const result = await run();
      status = 'resolved';
      return result;
    } finally {
      this.record(name, work, Date.now() - startedAt, status);
    }
  }

  /** 同步版本：装配期大量步骤是同步的（读设置、建注册表），不该为了计时改成异步。 */
  phaseSync<T>(name: string, work: string, run: () => T): T {
    const startedAt = Date.now();
    this.start(name, work);
    let status: 'resolved' | 'rejected' = 'rejected';
    try {
      const result = run();
      status = 'resolved';
      return result;
    } finally {
      this.record(name, work, Date.now() - startedAt, status);
    }
  }

  /**
   * 记一个**不由本实例包裹**的耗时（例如引擎内部算好的首 token 间隔）。
   *
   * 单独开这个方法而不是让调用方自己 log：汇总表的完整性依赖所有阶段都进
   * `records`，漏一条就会出现「汇总加起来不等于总耗时」却看不出缺了谁。
   */
  recordExternal(
    name: string,
    work: string,
    durationMs: number,
    status?: 'resolved' | 'rejected',
  ): void {
    this.record(name, work, durationMs, status);
  }

  /** 汇总表。在 init 帧出门与首 token 到达两个边界各打一次。 */
  summary(title: string): void {
    this.log(`[会话阶段汇总] ${title}`, {
      sessionId: this.sessionId,
      自受理起ms: Date.now() - this.receivedAt,
      阶段: this.records.map((r) => `${r.name}=${r.durationMs}ms`),
    });
  }

  private log(message: string, fields: Record<string, unknown>): void {
    try {
      runLogger.log(message, fields);
    } catch {
      // 日志失败不能阻止阶段执行或覆盖原始异常。
    }
  }

  private start(name: string, work: string): void {
    this.log(`[会话阶段开始] ${name}`, {
      sessionId: this.sessionId,
      工作: work,
      event: 'started',
      自受理起ms: Date.now() - this.receivedAt,
    });
  }

  private record(
    name: string,
    work: string,
    durationMs: number,
    status?: 'resolved' | 'rejected',
  ): void {
    this.records.push({
      name,
      work,
      durationMs,
      ...(status ? { status } : {}),
    });
    this.log(`[会话阶段] ${name}`, {
      sessionId: this.sessionId,
      工作: work,
      耗时ms: durationMs,
      ...(status ? { event: 'finished', status } : {}),
      自受理起ms: Date.now() - this.receivedAt,
    });
  }
}
