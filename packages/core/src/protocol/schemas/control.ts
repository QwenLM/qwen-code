/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zod schemas for the control protocol envelopes.
 *
 * Coverage policy:
 *
 * - Outer envelopes (`control_request`, `control_response`,
 *   `control_cancel_request`, `control_cancel`, `keep_alive`) are validated
 *   strictly. The CLI's NDJSON reader uses these to reject malformed input
 *   instead of silently dropping it.
 *
 * - Inner request payloads (`request.type === 'initialize'`, `'set_model'`,
 *   …) are validated only at the discriminant level (`{ type: string,
 *   subtype?: string, … }.passthrough()`). Field-level validation lives in
 *   the per-handler dispatch points — that's where we already need
 *   purpose-specific logic to construct responses. Adding deep schemas here
 *   would duplicate that work.
 *
 * Each envelope schema is bound to its `../wire/control.ts` type via
 * `satisfies z.ZodType<...>`, so envelope-shape drift is a compile error.
 */

import { z } from 'zod';
import type {
  SDKControlCancelRequest as ProtoSDKControlCancelRequest,
  SDKKeepAliveMessage as ProtoSDKKeepAliveMessage,
} from '../wire/index.js';
import { lazySchema } from '../utils/lazySchema.js';

/**
 * NOTE on `satisfies` coverage:
 *
 * - `SDKControlCancelRequestSchema` and `SDKKeepAliveSchema` are bound to
 *   their protocol types via `satisfies z.ZodType<...>`. Their shapes are
 *   simple enough to fully validate, so drift becomes a compile error.
 *
 * - `SDKControlRequestEnvelopeSchema` and `SDKControlResponseEnvelopeSchema`
 *   intentionally use a permissive shape for the inner request/response
 *   payload (`Record<string, unknown>` with a discriminant check). Binding
 *   them to the strict `SDKControlRequest` / `SDKControlResponse` types
 *   would force a fully-deep zod schema for every inner request type,
 *   doubling the surface area we'd have to maintain. Per-handler dispatch
 *   already does field-level validation when it constructs a typed view of
 *   the inner payload — adding a redundant deep schema here was the
 *   trade-off considered and rejected.
 */

/**
 * Inner control request body — minimum shape: must have `type` (string)
 * OR `subtype` (string). Some legacy variants (e.g. permission_response,
 * mcp_message) use `subtype` instead of `type`.
 */
const ControlRequestInnerLooseSchema = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
  })
  .passthrough()
  .refine((v) => typeof v.type === 'string' || typeof v.subtype === 'string', {
    message: 'control_request body must have a `type` or `subtype` string',
  });

/** `control_request` envelope. Inner payload validated only by discriminant. */
export const SDKControlRequestEnvelopeSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('control_request'),
      session_id: z.string().min(1).optional(),
      request_id: z.string(),
      request: ControlRequestInnerLooseSchema,
    })
    .strict(),
);

/** Inner of `control_response`: success or error. */
const ControlSuccessResponseSchema = z.object({
  subtype: z.literal('success'),
  request_id: z.string(),
  response: z.record(z.string(), z.unknown()).optional(),
});

const ControlErrorResponseSchema = z.object({
  subtype: z.literal('error'),
  request_id: z.string(),
  error: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  // pending_permission_requests intentionally typed loose — a self-referential
  // schema for SDKControlRequest would force the recursive zod dance for
  // little gain. Field-level handlers know what to expect.
  pending_permission_requests: z.array(z.unknown()).optional(),
});

/** `control_response` envelope. Outer envelope strict; inner success body permissive. */
export const SDKControlResponseEnvelopeSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('control_response'),
      session_id: z.string().min(1).optional(),
      response: z.union([
        ControlSuccessResponseSchema,
        ControlErrorResponseSchema,
      ]),
    })
    .strict(),
);

/** `control_cancel_request` / `control_cancel` envelope. */
export const SDKControlCancelRequestSchema = lazySchema(
  () =>
    z
      .object({
        type: z.union([
          z.literal('control_cancel_request'),
          z.literal('control_cancel'),
        ]),
        session_id: z.string().min(1).optional(),
        request_id: z.string(),
      })
      .strict() satisfies z.ZodType<ProtoSDKControlCancelRequest>,
);

/** `keep_alive` heartbeat. */
export const SDKKeepAliveSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('keep_alive'),
    }) satisfies z.ZodType<ProtoSDKKeepAliveMessage>,
);
