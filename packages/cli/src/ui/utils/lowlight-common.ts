/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Named re-exports let the bundler drop lowlight's `all` grammar set, which a
// dynamic import of the package root would evaluate on every launch.
export { common, createLowlight } from 'lowlight';
