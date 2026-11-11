/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { sessionLogger } from '@qwen-code/core';
import type { ConfiguredStartupContext } from '../startupContext.js';

type RouteLogContext = Pick<
  ConfiguredStartupContext,
  'settings' | 'policy'
> & {
  config?: Pick<ConfiguredStartupContext['config'], 'getSessionId'>;
};

/** 记录已完成配置后实际进入的启动分支，关联到当前会话诊断日志。 */
export function logRouteEntered(
  context: RouteLogContext,
  route: string,
): void {
  const sessionId = context.config?.getSessionId?.();
  const argv = context.settings?.argv;
  sessionLogger.event({
    level: 'info',
    kind: 'cli',
    type: 'cli.route.entered',
    ...(sessionId ? { ids: { session_id: sessionId } } : {}),
    data: {
      route,
      mode: context.policy?.mode.kind,
      input_format: argv?.inputFormat,
      output_format: argv?.outputFormat,
    },
  });
}
