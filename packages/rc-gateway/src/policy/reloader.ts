/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DebouncedReloader,
  type DebouncedReloaderOptions,
} from '../reload/debouncedReloader.js';
import type { Policy } from './loader.js';

/**
 * Options for {@link PolicyReloader}. `apply` MUST be synchronous so a reload is
 * atomic relative to an in-flight `handlePermission` await-boundary (the
 * enforcer's `setPolicy` assignment + the quota `limitsFor` map mutation are both
 * sync, so a reload landing mid-handler can't tear state — the handler already
 * captured its decision from the old policy and only re-checks `remaining(ruleId)`
 * against the new limits, which is fail-safe).
 */
export type PolicyReloaderOptions = DebouncedReloaderOptions<Policy>;

/**
 * Debounced policy hot-reloader. A reload that throws/rejects RETAINS the previous
 * policy and reports via `onError` (design.md:74; spec "Parse error preserves
 * previous ruleset"). A thin specialization of {@link DebouncedReloader} over
 * {@link Policy} — the debounce/coalesce/retain-on-error machinery lives in the
 * generic so the routing reloader reuses it verbatim.
 */
export class PolicyReloader extends DebouncedReloader<Policy> {}
