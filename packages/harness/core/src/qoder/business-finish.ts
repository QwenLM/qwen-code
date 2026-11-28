/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BusinessInfo } from './business-info.js';
import { runLogger } from '../utils/runLogger.js';

/** 一次业务结束事件；上报目标是产品后端的职责，core 不持有出站实现。 */
export interface ReportBusinessFinishParams {
  sessionId: string;
  businessInfo: Readonly<BusinessInfo>;
}

/** 产品侧实现：把业务结束事件送到自己的结算后端。 */
export type BusinessFinishReporter = (
  params: ReportBusinessFinishParams,
) => Promise<void>;

let reporter: BusinessFinishReporter | undefined;

/**
 * 注册产品侧上报实现，返回注销函数。
 *
 * core 只保留调用点；未注册时上报静默跳过，开源构建因此不依赖任何
 * 结算后端，也不需要端点、凭据或签名上下文。
 */
export function setBusinessFinishReporter(
  next: BusinessFinishReporter | undefined,
): () => void {
  reporter = next;
  return () => {
    if (reporter === next) reporter = undefined;
  };
}

export async function reportBusinessFinish(
  params: ReportBusinessFinishParams,
): Promise<void> {
  if (!params.businessInfo.id) {
    runLogger.debug(
      '[BusinessFinish] Skipped report because business id is empty',
    );
    return;
  }
  if (!reporter) {
    runLogger.warn('[BusinessFinish] Skipped report: no reporter registered');
    return;
  }
  await reporter(params);
}
