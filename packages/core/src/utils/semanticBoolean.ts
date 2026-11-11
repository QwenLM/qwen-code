/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

/**
 * Boolean that also accepts the string literals "true"/"false".
 *
 * Tool inputs arrive as model-generated JSON. The model occasionally quotes
 * booleans — `"replace_all":"false"` instead of `"replace_all":false` — and
 * z.boolean() rejects that with a type error. z.coerce.boolean() is the wrong
 * fix: it uses JS truthiness, so "false" → true.
 *
 * z.preprocess emits {"type":"boolean"} to the API schema, so the model is
 * still told this is a boolean — the string tolerance is invisible client-side
 * coercion, not an advertised input shape.
 *
 * .optional()/.default() go INSIDE (on the inner schema), not chained after.
 *
 *   semanticBoolean()                              → boolean
 *   semanticBoolean(z.boolean().optional())        → boolean | undefined
 *   semanticBoolean(z.boolean().default(false))    → boolean
 */
export function semanticBoolean<T extends z.ZodType>(
  inner: T = z.boolean() as unknown as T,
) {
  return z.preprocess(
    (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v),
    inner,
  );
}
