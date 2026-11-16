/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TuiRendererChoice } from './opentui/renderer-selection.js';

/**
 * The renderer that actually mounted for this interactive session.
 *
 * `selectTuiRenderer` only decides eligibility; a requested OpenTUI can still
 * fail to import or boot and fall back to ink without the environment changing.
 * The entry records the renderer that successfully started here so diagnostics
 * (`/about`, `/bug`) report the session that is really running, not the one
 * that was requested.
 */
let rendererOfRecord: TuiRendererChoice | undefined;

export function setTuiRendererOfRecord(renderer: TuiRendererChoice): void {
  rendererOfRecord = renderer;
}

export function getTuiRendererOfRecord(): TuiRendererChoice | undefined {
  return rendererOfRecord;
}
