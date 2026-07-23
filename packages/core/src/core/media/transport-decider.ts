/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { MediaProbe } from '../../utils/media/types.js';
import { getMaxInlineMediaBytes } from '../inlineMediaLimit.js';

/**
 * P2 · Transport decider (Pattern P · provider-coupled hard logic).
 *
 * Bytes must reach the model. Small media inline as base64; media past the
 * inline limit must be uploaded so it can be referenced by `fileData.fileUri`.
 * "There must be a transport" is A-class; *which* upload backend is used is a
 * provider/deployment choice resolved by `determineUploader`.
 */

export interface TransportDecision {
  mode: 'inline' | 'upload';
  /** The inline byte ceiling used for this decision. */
  inlineLimitBytes: number;
  reason: string;
}

export function decideTransport(
  probe: MediaProbe,
  _config: Config,
): TransportDecision {
  const inlineLimitBytes = getMaxInlineMediaBytes();
  if (probe.sizeBytes <= inlineLimitBytes) {
    return {
      mode: 'inline',
      inlineLimitBytes,
      reason: `${probe.sizeBytes}B ≤ ${inlineLimitBytes}B inline limit`,
    };
  }
  return {
    mode: 'upload',
    inlineLimitBytes,
    reason: `${probe.sizeBytes}B > ${inlineLimitBytes}B inline limit; upload required`,
  };
}
