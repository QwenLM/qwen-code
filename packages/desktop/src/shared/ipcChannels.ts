/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const IPC_CHANNELS = {
  getServerInfo: 'qwen-desktop:get-server-info',
  selectDirectory: 'qwen-desktop:select-directory',
  openPath: 'qwen-desktop:open-path',
  showItemInFolder: 'qwen-desktop:show-item-in-folder',
  writeClipboardText: 'qwen-desktop:write-clipboard-text',
  windowMinimize: 'qwen-desktop:window:minimize',
  windowMaximize: 'qwen-desktop:window:maximize',
  windowClose: 'qwen-desktop:window:close',
  windowIsMaximized: 'qwen-desktop:window:is-maximized',
} as const;
