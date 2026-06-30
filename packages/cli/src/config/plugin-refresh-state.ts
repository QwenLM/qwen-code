/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { appEvents, AppEvent } from '../utils/events.js';

let pluginRefreshNeeded = false;

export function markPluginsChanged(reason?: string): boolean {
  if (pluginRefreshNeeded) {
    return false;
  }
  pluginRefreshNeeded = true;
  appEvents.emit(AppEvent.PluginRefreshNeeded, reason);
  return true;
}

export function clearPluginsChanged(): void {
  pluginRefreshNeeded = false;
}

export function needsPluginRefresh(): boolean {
  return pluginRefreshNeeded;
}

export function resetPluginRefreshStateForTesting(): void {
  pluginRefreshNeeded = false;
}
