/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { closeSync, constants, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Storage } from '../config/storage.js';
import { getQwenOAuthConfig, QWEN_SUBSCRIPTION_MODEL } from './oauth-config.js';

export const subscriptionModelIdsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[^,\p{C}\p{Zl}\p{Zp}]+$/u),
  )
  .min(1);

export const SUBSCRIPTION_MODELS_UNAVAILABLE =
  'Could not load Qwen Subscription models. Your account is still signed in. Please try again.';
export const SUBSCRIPTION_MODELS_CACHED =
  'Provider model list unavailable; using the last successfully loaded models.';

export function subscriptionModelUnavailable(model: string): string {
  return `The selected model, ${model}, is no longer available. Run /model to choose another model.`;
}

export class SubscriptionModelSelectionError extends Error {
  constructor(model: string) {
    super(subscriptionModelUnavailable(model));
  }
}

export function selectSubscriptionModel(
  models: string[],
  selected?: string,
): string {
  if (selected) {
    if (!models.includes(selected))
      throw new SubscriptionModelSelectionError(selected);
    return selected;
  }
  if (!models.length) throw new Error(SUBSCRIPTION_MODELS_UNAVAILABLE);
  return models.includes(QWEN_SUBSCRIPTION_MODEL)
    ? QWEN_SUBSCRIPTION_MODEL
    : models[0]!;
}

export function readCachedSubscriptionModels(): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(
      path.join(Storage.getGlobalQwenDir(), 'subscription_credentials.json'),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const value = z
      .object({
        baseUrl: z.string(),
        clientId: z.string(),
        tokens: z.object({ access_token: z.string().min(1) }),
        models: subscriptionModelIdsSchema,
      })
      .parse(JSON.parse(readFileSync(fd, 'utf8')));
    const config = getQwenOAuthConfig();
    return value.baseUrl === config.baseUrl &&
      value.clientId === config.clientId
      ? value.models
      : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
