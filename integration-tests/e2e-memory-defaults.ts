/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Settings } from '../packages/cli/src/config/settings.js';

// Since #12913 the managed-memory extractor fires a forked-agent model
// request on every tool-completing turn and the headless CLI awaits it before
// exit — dead latency and extra endpoint load for runs that never assert
// memory behavior. Suites that need it opt back in per key via
// options.settings. The `satisfies` tie to the settings schema turns a key
// rename into a typecheck:integration failure instead of silently
// re-enabling the extractor. Both harnesses share this single definition so
// their defaults cannot drift apart.
export const E2E_MEMORY_SETTINGS_DEFAULTS = {
  enableManagedAutoMemory: false,
  enableManagedAutoDream: false,
} satisfies Settings['memory'];
