/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
} from '../bridge/protocol.js';

export interface ClientHello {
  type: 'client.hello';
  protocolVersion: number;
  clientId: string;
}

export interface ClientWelcome {
  type: 'client.welcome';
  protocolVersion: number;
  extensionConnected: boolean;
}

export interface ConnectionState {
  type: 'connection';
  connected: boolean;
}

export type BrokerClientMessage = ClientHello | BridgeRequest;

export type BrokerServerMessage =
  | ClientWelcome
  | ConnectionState
  | BridgeResponse
  | BridgeEvent;
