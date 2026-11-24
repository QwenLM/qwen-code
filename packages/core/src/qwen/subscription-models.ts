/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

const subscriptionModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^,\p{C}\p{Zl}\p{Zp}]+$/u);

const contextWindowSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const inputModalitySchema = z.enum(['text', 'image', 'video', 'audio', 'pdf']);
const thinkingStrengthEntrySchema = z.object({
  level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  budget_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type SubscriptionThinkingStrength = Array<
  z.infer<typeof thinkingStrengthEntrySchema>
>;
const thinkingStrengthSchema = z
  .array(thinkingStrengthEntrySchema.optional().catch(undefined))
  .transform((entries) => {
    const levels = new Set<string>();
    const valid = entries.filter(
      (entry): entry is z.infer<typeof thinkingStrengthEntrySchema> => {
        if (!entry || levels.has(entry.level)) return false;
        levels.add(entry.level);
        return true;
      },
    );
    return valid.length ? valid : undefined;
  })
  .optional()
  .catch(undefined);

const subscriptionModelSchema = z.object({
  id: subscriptionModelIdSchema,
  input_modalities: z
    .array(inputModalitySchema)
    .min(1)
    .optional()
    .catch(undefined),
  context_window_tokens: contextWindowSchema.optional().catch(undefined),
  display_name: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  thinking_strength: thinkingStrengthSchema,
});

export const subscriptionScenesSchema = z.object({
  fast: z.array(subscriptionModelSchema).optional(),
  compaction: z.array(subscriptionModelSchema).optional(),
  vision: z.array(subscriptionModelSchema).optional(),
  image: z.array(subscriptionModelSchema).optional(),
  voice: z.array(subscriptionModelSchema).optional(),
});
export type SubscriptionSceneCatalog = z.infer<typeof subscriptionScenesSchema>;
export type SubscriptionScene = keyof SubscriptionSceneCatalog;
export const subscriptionScenesResponseSchema = z.object({
  data: subscriptionScenesSchema,
});

export const subscriptionModelsResponseSchema = z.object({
  data: z.array(subscriptionModelSchema).min(1),
});

export interface SubscriptionModelMetadata {
  id: string;
  modalities?: {
    image?: boolean;
    video?: boolean;
    audio?: boolean;
    pdf?: boolean;
  };
  contextWindowSize?: number;
  name?: string;
  description?: string;
  thinkingStrength?: SubscriptionThinkingStrength;
}
export interface SubscriptionModelCatalog {
  models: string[];
  modelMetadata?: SubscriptionModelMetadata[];
  scenes?: SubscriptionSceneCatalog;
}

export function synchronizeSubscriptionThinkingStrength(
  catalog: SubscriptionModelCatalog,
  source: 'models' | 'scenes',
): SubscriptionModelCatalog {
  const metadata = new Map(
    catalog.modelMetadata?.map((model) => [model.id, model]),
  );
  const updates = new Map<string, SubscriptionThinkingStrength | undefined>();
  if (source === 'models') {
    for (const id of catalog.models)
      updates.set(id, metadata.get(id)?.thinkingStrength);
  } else {
    for (const models of Object.values(catalog.scenes ?? {})) {
      for (const model of models ?? []) {
        if (!updates.get(model.id)?.length)
          updates.set(model.id, model.thinking_strength);
      }
    }
  }
  const modelMetadata = catalog.models.flatMap((id) => {
    const previous = metadata.get(id);
    if (!updates.has(id)) return previous ? [previous] : [];
    const { thinkingStrength: _previous, ...rest } = previous ?? { id };
    const thinkingStrength = updates.get(id);
    const next = {
      ...rest,
      ...(thinkingStrength?.length ? { thinkingStrength } : {}),
    };
    return Object.keys(next).length > 1 ? [next] : [];
  });
  const scenes =
    catalog.scenes &&
    Object.fromEntries(
      Object.entries(catalog.scenes).map(([scene, models]) => [
        scene,
        models?.map((model) => {
          if (!updates.has(model.id)) return model;
          const { thinking_strength: _previous, ...rest } = model;
          const thinking_strength = updates.get(model.id);
          return {
            ...rest,
            ...(thinking_strength?.length ? { thinking_strength } : {}),
          };
        }),
      ]),
    );
  return {
    models: catalog.models,
    modelMetadata: modelMetadata.length ? modelMetadata : undefined,
    ...(scenes !== undefined ? { scenes } : {}),
  };
}

export const SUBSCRIPTION_MODELS_UNAVAILABLE =
  'Could not load Qwen Subscription models. Your account is still signed in. Please try again.';

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
