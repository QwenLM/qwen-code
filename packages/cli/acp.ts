/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** ACP 产品扩展面：基类 AcpServer 与少量可复用助手。 */
export { AcpServer, type AcpServerParams } from './src/acp/acpServer.js';
export {
  formatReasoningEffortName,
  type AcpModelAdapter,
} from './src/acp/acpSupport.js';
export { getAcpErrorMessage } from './src/acp/acpErrors.js';
export { getStructuredAuthErrorCode } from './src/utils/errors.js';
