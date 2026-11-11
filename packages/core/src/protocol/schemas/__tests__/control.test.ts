/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  SDKControlRequestEnvelopeSchema,
  SDKControlResponseEnvelopeSchema,
  SDKControlCancelRequestSchema,
  SDKKeepAliveSchema,
} from '../control.js';

describe('control protocol envelopes', () => {
  describe('SDKControlRequestEnvelopeSchema', () => {
    it('accepts a valid initialize request', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          type: 'initialize',
          model: 'gpt-4',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid set_permission_mode request', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        request_id: 'req-2',
        request: { type: 'set_permission_mode', mode: 'acceptEdits' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts and preserves a routed request session_id', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        session_id: 'session-1',
        request_id: 'req-routed',
        request: { type: 'interrupt' },
      });
      expect(result).toMatchObject({
        success: true,
        data: { session_id: 'session-1' },
      });
    });

    it('accepts the legacy can_use_tool subtype variant', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        request_id: 'req-3',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Read',
          tool_use_id: 't-1',
          input: {},
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects when request_id is missing', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        request: { type: 'interrupt' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects when inner request lacks both type and subtype', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        request_id: 'req-bad',
        request: { foo: 'bar' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an outer type mismatch', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'user',
        request_id: 'req-4',
        request: { type: 'interrupt' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unexpected request envelope key', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        request_id: 'req-unexpected-key',
        request: { type: 'interrupt' },
        unexpected: true,
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty request session_id', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        session_id: '',
        request_id: 'req-empty-session',
        request: { type: 'interrupt' },
      });
      expect(result.success).toBe(false);
    });

    it('keeps a direct request without session_id valid', () => {
      const result = SDKControlRequestEnvelopeSchema().safeParse({
        type: 'control_request',
        request_id: 'req-direct',
        request: { type: 'interrupt' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('SDKControlResponseEnvelopeSchema', () => {
    it('accepts a success response', () => {
      const result = SDKControlResponseEnvelopeSchema().safeParse({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-1',
          response: { ok: true },
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts an error response', () => {
      const result = SDKControlResponseEnvelopeSchema().safeParse({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'req-1',
          error: 'boom',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts and preserves a routed error response with retry details', () => {
      const result = SDKControlResponseEnvelopeSchema().safeParse({
        type: 'control_response',
        session_id: 'session-2',
        response: {
          subtype: 'error',
          request_id: 'req-error',
          error: 'try again',
          retryable: true,
          details: { retry_after_ms: 1000 },
        },
      });
      expect(result).toMatchObject({
        success: true,
        data: {
          session_id: 'session-2',
          response: {
            retryable: true,
            details: { retry_after_ms: 1000 },
          },
        },
      });
    });

    it('rejects when subtype is missing', () => {
      const result = SDKControlResponseEnvelopeSchema().safeParse({
        type: 'control_response',
        response: { request_id: 'req-1' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unexpected response envelope key', () => {
      const result = SDKControlResponseEnvelopeSchema().safeParse({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-unexpected-key',
        },
        unexpected: true,
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty response session_id', () => {
      const result = SDKControlResponseEnvelopeSchema().safeParse({
        type: 'control_response',
        session_id: '',
        response: {
          subtype: 'success',
          request_id: 'req-empty-session',
        },
      });
      expect(result.success).toBe(false);
    });

    it('keeps a direct response without session_id valid', () => {
      const result = SDKControlResponseEnvelopeSchema().safeParse({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-direct',
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('SDKControlCancelRequestSchema', () => {
    it('accepts both control_cancel_request and control_cancel', () => {
      expect(
        SDKControlCancelRequestSchema().safeParse({
          type: 'control_cancel_request',
          request_id: 'r1',
        }).success,
      ).toBe(true);
      expect(
        SDKControlCancelRequestSchema().safeParse({
          type: 'control_cancel',
          request_id: 'r2',
        }).success,
      ).toBe(true);
    });

    it('rejects an unrelated type', () => {
      const result = SDKControlCancelRequestSchema().safeParse({
        type: 'foo',
        request_id: 'r1',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unexpected cancel envelope key', () => {
      const result = SDKControlCancelRequestSchema().safeParse({
        type: 'control_cancel',
        request_id: 'req-unexpected-key',
        unexpected: true,
      });
      expect(result.success).toBe(false);
    });

    it('accepts and preserves a routed cancel session_id', () => {
      const result = SDKControlCancelRequestSchema().safeParse({
        type: 'control_cancel',
        session_id: 'session-3',
        request_id: 'req-cancel',
      });
      expect(result).toMatchObject({
        success: true,
        data: { session_id: 'session-3' },
      });
    });

    it('rejects an empty cancel session_id', () => {
      const result = SDKControlCancelRequestSchema().safeParse({
        type: 'control_cancel_request',
        session_id: '',
        request_id: 'req-empty-session',
      });
      expect(result.success).toBe(false);
    });

    it('keeps a direct cancel without session_id valid', () => {
      const result = SDKControlCancelRequestSchema().safeParse({
        type: 'control_cancel',
        request_id: 'req-direct',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('SDKKeepAliveSchema', () => {
    it('accepts a keep_alive', () => {
      expect(
        SDKKeepAliveSchema().safeParse({ type: 'keep_alive' }).success,
      ).toBe(true);
    });

    it('rejects a non-keep_alive', () => {
      expect(SDKKeepAliveSchema().safeParse({ type: 'user' }).success).toBe(
        false,
      );
    });
  });
});
