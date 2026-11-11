/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Readable, Writable } from 'node:stream';
import { FatalInputError, type Config } from '@qwen-code/core';
import type { DaemonAppFramework } from '../framework/daemonAppFramework.js';

export interface SdkServerParams {
  readonly input: Readable;
  readonly output: Writable;
  readonly config: Config;
  readonly framework: DaemonAppFramework;
}

/**
 * SDK daemon 宿主基类。开源构建没有 daemon 实现，产品入口通过
 * `AppFramework.createSdkServer` 替换为真正的服务端。
 */
export class SdkServer {
  constructor(protected readonly params: SdkServerParams) {}

  async run(): Promise<void> {
    throw new FatalInputError('SDK daemon mode is not supported by this build');
  }
}
