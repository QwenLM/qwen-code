/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelSelection } from '../provider/model/modelSelection.js';
import { QODER_PROVIDER_ID } from '../provider/modelProvider.js';

import type { Config } from '../config/config.js';
import type { NormalizeMessagesForAPIOptions } from '../protocol/provider/request-converter.js';

/** 仅为端侧直连目标提供 provider 身份，服务端路由不启用端侧清洗。 */
export function buildModelProjectionOptions(
  config: Config | undefined,
  targetModel: string | undefined,
  resolution?: ModelSelection,
): NormalizeMessagesForAPIOptions {
  if (targetModel === undefined) return {};

  const providerId = resolution
    ? resolution.model.source === QODER_PROVIDER_ID
      ? undefined
      : resolution.model.source
    : config?.getCustomProviderRegistry?.().getProviderForModel?.(targetModel)
        ?.providerId;
  return {
    targetModel,
    ...(providerId ? { targetCustomProviderId: providerId } : {}),
  };
}
