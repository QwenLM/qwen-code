/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `extractAgentText` was promoted to the shared `../sessionUpdateText.js` (used by
// both the Discord and Matrix streaming bridges). Re-exported here so existing
// imports (and the streamFrame tests) keep resolving unchanged.
export { extractAgentText } from '../sessionUpdateText.js';
