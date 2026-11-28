/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { WebShellLanguage } from './i18n';

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | 'unavailable';

export interface BrowserNotificationSettings {
  enabled: boolean;
  permission: BrowserNotificationPermissionState;
  pending: boolean;
  persistent: boolean;
  error: boolean;
  setEnabled(enabled: boolean): Promise<void>;
  requestPermissionOnce(): void;
  refreshPermission(): void;
  syncLanguage(language: WebShellLanguage): void;
}

export const BrowserNotificationSettingsContext = createContext<
  BrowserNotificationSettings | undefined
>(undefined);

export function useBrowserNotificationSettings() {
  return useContext(BrowserNotificationSettingsContext);
}
