/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelProtocol } from './modelProtocol.js';
import type { ModelTransport } from './modelTransport.js';

export class ModelTransportManager {
  private readonly transports: Map<ModelProtocol, ModelTransport>;

  constructor(transports: readonly ModelTransport[]) {
    const map = new Map<ModelProtocol, ModelTransport>();
    for (const transport of transports) {
      map.set(transport.protocol, transport);
    }
    this.transports = map;
  }

  resolve(protocol: ModelProtocol): ModelTransport {
    const transport = this.transports.get(protocol);
    if (!transport) {
      throw new Error(
        `ModelTransportManager: protocol not supported: ${protocol}`,
      );
    }
    return transport;
  }
}
