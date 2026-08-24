/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Leaf module for the omni delivery activation check, split out of
 * `omni/index.ts` so lightweight consumers (system-prompt assembly in
 * client.ts, media-guidance.ts) can evaluate the gate without statically
 * pulling in the whole delivery pipeline (storage, upload, ffmpeg,
 * policy orchestrator).
 */

import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { DashScopeOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/dashscope.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isSelfHostedOssConfigured } from './oss-upload.js';

const debugLogger = createDebugLogger('omni:delivery-gate');

/**
 * Placeholder the model-config resolver assigns under Qwen OAuth; the real
 * token is swapped in per-request by QwenContentGenerator and never lands
 * in the ContentGeneratorConfig, so it cannot authenticate the uploads
 * endpoint. See modelConfigResolver.ts.
 */
const QWEN_OAUTH_PLACEHOLDER_API_KEY = 'QWEN_OAUTH_DYNAMIC_TOKEN';

/**
 * Gate for the omni delivery path. All conditions must hold:
 *
 * 1. omni enabled (settings or QWEN_CODE_ENABLE_OMNI=1);
 * 2. trusted workspace (the pipeline writes .qwen/omni/ and uploads
 *    workspace bytes off-machine);
 * 3. a usable API key for the uploads endpoint — Qwen OAuth is excluded:
 *    its ContentGeneratorConfig carries a placeholder, and the OAuth token
 *    is not accepted by the uploads channel;
 * 4. an explicit baseUrl (the uploads origin is derived from it — never
 *    send the configured credential to an origin the user didn't set);
 * 5. a DashScope-compatible provider, OR a fully configured self-hosted
 *    delivery bucket (OMNI_OSS_*) — provider detection is hostname-based,
 *    so an endpoint on a bare IP is never DashScope-compatible, yet it can
 *    still read presigned URLs from our own bucket.
 *
 * Any failed condition falls back to the pre-omni inline behavior.
 * Modality support is checked by the caller (fileUtils) alongside the
 * existing modality gate.
 */
export function isOmniDeliveryActive(config: Config): boolean {
  // Optional calls so stub Configs in tests (and embedders constructing
  // partial configs) don't need the omni accessors to process files.
  if (!config.isOmniEnabled?.()) return false;
  if (config.isTrustedFolder?.() === false) {
    debugLogger.debug('omni delivery inactive: untrusted workspace');
    return false;
  }
  const cgc = config.getContentGeneratorConfig?.();
  if (!cgc) return false;
  if (
    cgc.authType === AuthType.QWEN_OAUTH ||
    !cgc.apiKey ||
    cgc.apiKey === QWEN_OAUTH_PLACEHOLDER_API_KEY
  ) {
    debugLogger.debug(
      'omni delivery inactive: no static API key usable for the uploads endpoint (Qwen OAuth is not supported)',
    );
    return false;
  }
  if (!cgc.baseUrl) {
    debugLogger.debug(
      'omni delivery inactive: no explicit baseUrl to derive the uploads origin from',
    );
    return false;
  }
  return (
    DashScopeOpenAICompatibleProvider.isDashScopeProvider(cgc) ||
    isSelfHostedOssConfigured()
  );
}
