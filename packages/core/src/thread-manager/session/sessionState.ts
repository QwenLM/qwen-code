/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话级状态容器。
 *
 * 单进程多会话改造中，所有「per-session 生命周期」的对象都逐步迁移到这里，并在
 * {@link createSessionState} / `SessionState` 的初始化过程中按依赖顺序完成创建。
 * 一个 Config 对应一个 SessionState，在 Config 构造过程中创建、随会话结束释放。
 * ResourceService 存放共享资源；本类预留会话状态，不改变当前 Config 的归属。
 *
 * 目前为空壳：只提供清晰的创建入口与成员挂载点。迁移按业务域逐个进行——每迁一个
 * 会话级对象，就在 SessionStateInit 增加其入参、在构造函数里完成其初始化，并从
 * Config 移除对应成员。
 */

/** SessionState 的初始化入参。迁移进来的会话级对象在此声明其创建所需依赖。 */
export interface SessionStateInit {
  /** 所属会话 ID。 */
  sessionId: string;
}

/**
 * 会话级状态。一个会话一个实例，在 Config 构造过程中通过 {@link createSessionState}
 * 创建。构造私有，强制走工厂入口，保证创建路径唯一、清晰。
 */
export class SessionState {
  /** 所属会话 ID。 */
  readonly sessionId: string;

  private constructor(init: SessionStateInit) {
    this.sessionId = init.sessionId;
    // 会话级对象在此按依赖顺序初始化；当前为空壳，迁移时逐个补齐。
  }

  /** 唯一创建入口。 */
  static create(init: SessionStateInit): SessionState {
    return new SessionState(init);
  }
}

/** 会话级创建入口：Config 构造过程中调用。 */
export function createSessionState(init: SessionStateInit): SessionState {
  return SessionState.create(init);
}
