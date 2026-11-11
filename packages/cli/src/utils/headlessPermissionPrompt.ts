/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isRemoteWorkerMode, isSDKMode } from '@qwen-code/core';

export interface HeadlessPermissionPromptOptions {
  inputFormat?: string;
  permissionPromptTool?: string;
}

export interface HeadlessPermissionPromptMode {
  namedPermissionPromptTool?: string;
  useStdioPermissionPrompt: boolean;
  installStdioPermissionHandler: boolean;
  hasExternalPermissionHandler: boolean;
}

export function isStdioPermissionPromptTool(
  permissionPromptTool?: string,
): boolean {
  return permissionPromptTool?.toLowerCase() === 'stdio';
}

export function getHeadlessPermissionPromptMode({
  inputFormat,
  permissionPromptTool,
}: HeadlessPermissionPromptOptions): HeadlessPermissionPromptMode {
  const isStdio = isStdioPermissionPromptTool(permissionPromptTool);
  const isNamedPermissionPromptTool =
    Boolean(permissionPromptTool) && !isStdio;
  const namedPermissionPromptTool = isNamedPermissionPromptTool
    ? permissionPromptTool
    : undefined;
  const useStdioPermissionPrompt =
    isStdio ||
    (!isNamedPermissionPromptTool && inputFormat === 'stream-json');

  return {
    namedPermissionPromptTool,
    useStdioPermissionPrompt,
    // SDK 仅在配置 canUseTool 时显式传入 stdio；未配置时由权限 Hook 决策。
    // 保留控制通道的其他能力，避免缺失回调的错误抢先结束 Hook。
    installStdioPermissionHandler:
      useStdioPermissionPrompt && (!isSDKMode() || isStdio),
    hasExternalPermissionHandler:
      useStdioPermissionPrompt ||
      isNamedPermissionPromptTool ||
      isRemoteWorkerMode(),
  };
}
