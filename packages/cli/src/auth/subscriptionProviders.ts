/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  QwenSubscriptionProvider,
  QwenSubscriptionSession,
  type ModelProvider,
  type ModelTransportManager,
} from '@qwen-code/core';
import type { SettingsService } from '@qwen-code/resource';

/** Account provider composition: only a signed-in session contributes models. */
export function createQwenSubscriptionProviders(
  settingsService: SettingsService,
  transportManager: ModelTransportManager,
): readonly ModelProvider[] {
  const session = new QwenSubscriptionSession();
  return session.isSignedIn()
    ? [createQwenSubscriptionProvider(settingsService, transportManager, session)]
    : [];
}

export function createQwenSubscriptionProvider(
  settingsService: SettingsService,
  transportManager: ModelTransportManager,
  session: QwenSubscriptionSession = new QwenSubscriptionSession(),
): QwenSubscriptionProvider {
  return new QwenSubscriptionProvider({
    settingsService,
    transportManager,
    session,
  });
}
