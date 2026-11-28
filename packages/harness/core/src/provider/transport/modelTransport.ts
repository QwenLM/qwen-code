/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelProtocol } from './modelProtocol.js';
import type { ModelStreamEvent } from '../event/modelStreamEvent.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';

/**
 * ModelTransport 可用的推理 client 形状壳：两家 client（开源 CustomClient、
 * 商业化 QoderClient）协议面无交集，契约层不做结构约束，
 * 具体类型由各实现收窄为自己服务的 client。
 */
export type ModelStreamClient = object;

/** 模型协议适配契约：只做出入参协议映射，网络发送委托给逐次传入的 Client。 */
export interface ModelTransport {
  /** 本实现固定的推理协议，一个实现只服务一种协议。 */
  readonly protocol: ModelProtocol;

  /**
   * 编码请求、经 Client API 发起流式调用并归一事件流；协议类型不向调用方暴露。
   *
   * client 只以形状壳出现：实现自行收窄为自己服务的 client 类型
   * （开源协议收 CustomClient、商业化收 QoderClient），
   * 本契约不持有执行器，实现可做成无状态单例。
   */
  stream(
    client: ModelStreamClient,
    request: ModelStreamRequest,
  ): AsyncGenerator<ModelStreamEvent>;
}
