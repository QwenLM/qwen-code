/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Public API for the StructuredIO module.
 *
 * StructuredIO provides bidirectional NDJSON communication between the
 * TS Agent SDK (parent process) and the CLI (child process) via stdin/stdout.
 *
 * The reader parses inbound NDJSON messages from stdin and routes them by type.
 * Outbound messages are written directly to stdout by the consumer.
 */

export {
  parseInboundUserMessage,
  StructuredIOReader,
  StructuredInputError,
  extractPromptText,
} from './structured-io-reader.js';

export type {
  StructuredIOReaderOptions,
  InboundMessage,
  InboundUserMessage,
  InboundControlRequest,
  InboundControlResponse,
  InboundControlCancelRequest,
  InboundKeepAlive,
} from './structured-io-reader.js';

// PendingRequestManager — bidirectional control protocol support
export { PendingRequestManager } from './pending-requests.js';
