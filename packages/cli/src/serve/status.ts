/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Re-export wrapper. The implementation lives in `@qwen-code/acp-bridge`
// (lifted in #4175 PR 22b). The 25-symbol import block in
// `acp-integration/acpAgent.ts:85-109` and every other internal caller
// keep resolving without churn.
//
// @see ../../../acp-bridge/src/status.ts for the implementation.
export * from '@qwen-code/acp-bridge/status';
