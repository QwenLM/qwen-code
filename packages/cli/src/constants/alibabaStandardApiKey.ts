/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type AlibabaStandardRegion =
  | 'cn-beijing'
  | 'sg-singapore'
  | 'us-virginia'
  | 'cn-hongkong';

export const DASHSCOPE_STANDARD_API_KEY_ENV_KEY = 'DASHSCOPE_API_KEY';

export const ALIBABA_STANDARD_API_KEY_ENDPOINTS: Record<
  AlibabaStandardRegion,
  string
> = {
  'cn-beijing': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'sg-singapore': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'us-virginia': 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  'cn-hongkong':
    'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
};
