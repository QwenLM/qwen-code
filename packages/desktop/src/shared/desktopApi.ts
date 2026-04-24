/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DesktopServerInfo {
  url: string;
  token: string;
}

export interface DesktopWindowApi {
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
}

export interface QwenDesktopApi {
  getServerInfo(): Promise<DesktopServerInfo>;
  selectDirectory(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  window: DesktopWindowApi;
}
