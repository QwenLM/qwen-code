/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

const model = z.string().trim().min(1);
const apiKey = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !/\$\{|^\$\w+$/.test(value),
    'must resolve from the environment',
  );
const baseUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, 'must be an HTTP(S) API root without credentials, query or fragment');

// Compatibility data shape; commercial parsing and defaults are supplied by the host.
export type JudgmentSettings =
  | { backend: 'typesafe'; model: string; baseUrl: string; apiKey: string }
  | { backend: 'bailian'; model: string };
export const typeSafeJudgmentSettingsSchema = z.object({
  backend: z.literal('typesafe'),
  model,
  baseUrl,
  apiKey,
});
export type TypeSafeJudgmentSettings = z.infer<
  typeof typeSafeJudgmentSettingsSchema
>;
export function parseJudgmentSettings(
  value: unknown,
): TypeSafeJudgmentSettings | undefined {
  if (value === undefined) return undefined;
  const parsed = typeSafeJudgmentSettingsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid judgment configuration: ${issue.path.join('.')} ${issue.message}`,
    );
  }
  return parsed.data;
}
