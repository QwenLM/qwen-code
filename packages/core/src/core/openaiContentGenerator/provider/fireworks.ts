/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

const FIREWORKS_API_HOST = 'api.fireworks.ai';

/**
 * Hostname-only detection: Fireworks serves third-party model names
 * (`accounts/fireworks/models/qwen3p8-max`, `llama-*`, ...), so a
 * model-name fallback would misroute other providers' models.
 */
export function isFireworksProvider(config: ContentGeneratorConfig): boolean {
  const baseUrl = config.baseUrl ?? '';
  if (!baseUrl) return false;

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === FIREWORKS_API_HOST ||
      hostname.endsWith(`.${FIREWORKS_API_HOST}`)
    );
  } catch {
    return false;
  }
}

/**
 * Fireworks accepts `messages[].reasoning_content` on input but rejects the
 * additional `reasoning` field the default provider mirrors it into for
 * qwen3 models (`400 Extra inputs are not permitted, field:
 * 'messages[N].reasoning'`), so every tool-call continuation after a
 * thinking turn failed (issue #11657). Whether a field is mirrored is a
 * property of the endpoint, not of the model family: keep the shared
 * history and `reasoning_content` intact and skip the mirror at the
 * outbound request boundary.
 */
export class FireworksOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isFireworksProvider = isFireworksProvider;

  protected override shouldMirrorReasoningContent(_model: string): boolean {
    return false;
  }
}
