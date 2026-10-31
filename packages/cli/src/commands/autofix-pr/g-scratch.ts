/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Throwaway fixture for the group G skill-level E2E of /autofix-pr --in-place.
// The explicit `any` trips @typescript-eslint/no-explicit-any so Lint & Static
// fails and the in-place round has a trivial, fixable check to address. This
// file is removed by the fix; the scratch PR is closed without merging.
export const gScratch: any = 1;