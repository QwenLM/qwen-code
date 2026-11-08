/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSessionDurableRef } from './managed-session-records.js';
import type {
  ToolResultManifest,
  ToolResultPrefix,
  ToolResultSealReceipt,
  ToolResultSegmentReceipt,
  ToolResultStoreOutcome,
} from './managed-tool-result.js';

export type ToolResultExpectedIdentity = Pick<
  ToolResultManifest,
  | 'tenantId'
  | 'sessionId'
  | 'turnId'
  | 'executionCallId'
  | 'callId'
  | 'invocationDigest'
  | 'bindingGeneration'
  | 'captureId'
  | 'revision'
>;

export interface ToolResultRangeRequest {
  readonly manifestRef: ManagedSessionDurableRef;
  readonly expectedIdentity: ToolResultExpectedIdentity;
  readonly streamId: string;
  readonly offset: number;
  readonly length: number;
}

/** Private, Session-owned storage for the O1a segment protocol. */
export interface ToolResultSegmentStore {
  publish(
    request: unknown,
  ): Promise<ToolResultStoreOutcome<ToolResultSegmentReceipt>>;
  seal(
    request: unknown,
  ): Promise<ToolResultStoreOutcome<ToolResultSealReceipt>>;
  prefix(request: unknown): Promise<ToolResultStoreOutcome<ToolResultPrefix>>;
  readRange(
    request: ToolResultRangeRequest,
  ): Promise<ToolResultStoreOutcome<Buffer>>;
  close(): Promise<void>;
}
