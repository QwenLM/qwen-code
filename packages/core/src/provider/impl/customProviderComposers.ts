/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';

import type { ModelProvider } from '../modelProvider.js';
import type { ModelTransportManager } from '../transport/modelTransportManager.js';
import type { ModelConfigStoreScope } from './modelConfigStore.js';

/** Raw `settings.providers.<id>` entry plus the session binding it needs. */
export interface ComposeCustomProviderContext {
  readonly providerId: string;
  readonly value: unknown;
  readonly transportManager: ModelTransportManager;
  readonly settingsService: SettingsService;
  readonly scope: ModelConfigStoreScope;
  readonly cwd?: string;
}

/**
 * Builds a provider for a reserved settings id that the generic custom-provider
 * parser rejects. Account-backed providers use this so their entry can still
 * live in settings without shipping account logic into the custom provider.
 */
export type CustomProviderComposer = (
  context: ComposeCustomProviderContext,
) => ModelProvider | undefined;

const composers = new Map<string, CustomProviderComposer>();

export function registerCustomProviderComposer(
  providerId: string,
  composer: CustomProviderComposer | undefined,
): void {
  if (composer) composers.set(providerId, composer);
  else composers.delete(providerId);
}

export function getCustomProviderComposer(
  providerId: string,
): CustomProviderComposer | undefined {
  return composers.get(providerId);
}

/** Ids captured by a composer are owned by their provider, not the generic parser. */
export function isComposedProviderId(providerId: string): boolean {
  return composers.has(providerId);
}

/**
 * Drops composer-owned entries from a raw `settings.providers` value so an
 * account provider entry is never reported as an invalid Custom Provider.
 */
export function withoutComposedProviderSettings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([providerId]) => !composers.has(providerId),
    ),
  );
}
