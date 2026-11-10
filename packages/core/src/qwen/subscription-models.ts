/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { closeSync, constants, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Storage } from '../config/storage.js';
import { getQwenOAuthConfig } from './oauth-config.js';

const subscriptionModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^,\p{C}\p{Zl}\p{Zp}]+$/u);
export const subscriptionModelIdsSchema = z
  .array(subscriptionModelIdSchema)
  .min(1);

const contextWindowSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const inputModalitySchema = z.enum(['text', 'image', 'video', 'audio', 'pdf']);

export const subscriptionModelsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: subscriptionModelIdSchema,
        input_modalities: z
          .array(inputModalitySchema)
          .min(1)
          .optional()
          .catch(undefined),
        context_window_tokens: contextWindowSchema.optional().catch(undefined),
      }),
    )
    .min(1),
});

const modelMetadataSchema = z.object({
  id: subscriptionModelIdSchema,
  modalities: z
    .object({
      image: z.boolean().optional(),
      video: z.boolean().optional(),
      audio: z.boolean().optional(),
      pdf: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),
  contextWindowSize: contextWindowSchema.optional().catch(undefined),
});
export const subscriptionModelMetadataSchema = z
  .array(modelMetadataSchema)
  .optional()
  .catch(undefined);
export type SubscriptionModelMetadata = z.infer<typeof modelMetadataSchema>;
export interface SubscriptionModelCatalog {
  models: string[];
  modelMetadata?: SubscriptionModelMetadata[];
}

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
  return models[0]!;
}

export function readCachedSubscriptionCatalog(): SubscriptionModelCatalog {
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
        modelMetadata: subscriptionModelMetadataSchema,
      })
      .parse(JSON.parse(readFileSync(fd, 'utf8')));
    const config = getQwenOAuthConfig();
    return value.baseUrl === config.baseUrl &&
      value.clientId === config.clientId
      ? { models: value.models, modelMetadata: value.modelMetadata }
      : { models: [] };
  } catch {
    return { models: [] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
