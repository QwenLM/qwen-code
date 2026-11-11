/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isRecord } from '../protocol/provider/qoder-api-error.js';
import { redactServerErrorText } from './serverErrorRedaction.js';
import { isAbortErrorDeep } from './errors.js';

/** 只透传服务端结构化说明；展示包装和本地异常正文不是原始业务消息。 */
export function getServerErrorMessage(error: unknown): string | undefined {
  if (isAbortErrorDeep(error)) return undefined;
  const seen = new Set<object>();
  let current = error;
  while (isRecord(current) && !seen.has(current) && seen.size < 16) {
    seen.add(current);
    for (const key of ['qoderApiError', 'providerError']) {
      const provider = current[key];
      if (!isRecord(provider)) continue;
      const message = provider['message'];
      if (typeof message !== 'string' || !message.trim()) continue;
      return redactServerErrorText(message);
    }
    current = current['cause'];
  }
  return undefined;
}
