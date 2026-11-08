/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isQwenQuotaExceededError,
  isProQuotaExceededError,
  isGenericQuotaExceededError,
  isApiError,
  isStructuredError,
  isQuotaExhaustedError,
  formatQuotaExhaustedMessage,
  type ApiError,
} from './quotaErrorDetection.js';

describe('quotaErrorDetection', () => {
  describe('isQwenQuotaExceededError', () => {
    it('should detect the Qwen insufficient_quota error', () => {
      const error = {
        status: 429,
        code: 'insufficient_quota',
        message: 'Free allocated quota exceeded.',
      };
      expect(isQwenQuotaExceededError(error)).toBe(true);
    });

    it('should not match when status is not 429', () => {
      const error = {
        status: 400,
        code: 'insufficient_quota',
        message: 'Free allocated quota exceeded.',
      };
      expect(isQwenQuotaExceededError(error)).toBe(false);
    });

    it('should not match temporary throttling (concurrency 429)', () => {
      const error = {
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded',
      };
      expect(isQwenQuotaExceededError(error)).toBe(false);
    });

    it('should not match paid account quota exceeded', () => {
      const error = {
        status: 429,
        code: 'insufficient_quota',
        message: 'You exceeded your current quota.',
      };
      expect(isQwenQuotaExceededError(error)).toBe(false);
    });

    it('should not match plain Error objects', () => {
      const error = new Error('insufficient_quota');
      expect(isQwenQuotaExceededError(error)).toBe(false);
    });

    it('should not match string errors', () => {
      expect(isQwenQuotaExceededError('insufficient_quota')).toBe(false);
    });

    it('should not match null or undefined', () => {
      expect(isQwenQuotaExceededError(null)).toBe(false);
      expect(isQwenQuotaExceededError(undefined)).toBe(false);
    });
  });

  describe('isProQuotaExceededError', () => {
    it('should detect Gemini Pro quota exceeded error', () => {
      const error = new Error(
        "Quota exceeded for quota metric 'Gemini 2.5 Pro Requests'",
      );
      expect(isProQuotaExceededError(error)).toBe(true);
    });

    it('should detect Gemini preview Pro quota exceeded error', () => {
      const error = new Error(
        "Quota exceeded for quota metric 'Gemini 2.5-preview Pro Requests'",
      );
      expect(isProQuotaExceededError(error)).toBe(true);
    });

    it('should not detect non-Pro quota errors', () => {
      const error = new Error(
        "Quota exceeded for quota metric 'Gemini 1.5 Flash Requests'",
      );
      expect(isProQuotaExceededError(error)).toBe(false);
    });
  });

  describe('isGenericQuotaExceededError', () => {
    it('should detect generic quota exceeded error', () => {
      const error = new Error('Quota exceeded for quota metric');
      expect(isGenericQuotaExceededError(error)).toBe(true);
    });

    it('should not detect non-quota errors', () => {
      const error = new Error('Network error');
      expect(isGenericQuotaExceededError(error)).toBe(false);
    });
  });

  describe('isQuotaExhaustedError', () => {
    it('detects the Bailian token-plan quota-exhaustion error', () => {
      const error = Object.assign(
        new Error(
          '429 Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.',
        ),
        { status: 429 },
      );
      expect(isQuotaExhaustedError(error)).toBe(true);
    });

    it('detects a plain-string quota-exhaustion message', () => {
      expect(
        isQuotaExhaustedError(
          'Your token-plan quota has been exceeded. It will reset at 2026-07-27.',
        ),
      ).toBe(true);
    });

    it('detects a reset-time message without the word "will"', () => {
      expect(
        isQuotaExhaustedError(
          new Error('Your quota is exhausted. Reset at 2026-08-01 00:00 UTC.'),
        ),
      ).toBe(true);
    });

    it('detects an ApiError-shaped quota-exhaustion message', () => {
      const error: ApiError = {
        error: {
          code: 429,
          message:
            'Your quota has been exhausted. It will reset at 2026-07-28.',
          status: 'RESOURCE_EXHAUSTED',
          details: [],
        },
      };
      expect(isQuotaExhaustedError(error)).toBe(true);
      expect(formatQuotaExhaustedMessage(error)).toContain(
        'Your quota has been exhausted. It will reset at 2026-07-28.',
      );
    });

    it('does not match transient throttling without a reset time', () => {
      expect(
        isQuotaExhaustedError(
          new Error('Rate limit exceeded. Please retry later.'),
        ),
      ).toBe(false);
    });

    it('does not match a 429 that only says quota without a reset time', () => {
      expect(isQuotaExhaustedError(new Error('Your quota is exhausted.'))).toBe(
        false,
      );
    });

    it('does not match quota + reset time without exhausted/exceeded', () => {
      // Pins the (exhausted || exceeded) clause: an OpenAI-style TPM body
      // "Rate limit reached … Your quota will reset at …" must stay false.
      expect(
        isQuotaExhaustedError(
          new Error(
            'Rate limit reached for gpt-4. Your quota will reset at 12:00:05Z.',
          ),
        ),
      ).toBe(false);
    });

    it('does not match exhausted + reset time without quota', () => {
      // Pins the quota clause.
      expect(
        isQuotaExhaustedError(
          new Error('Resources exhausted. Will reset at 2026-08-01.'),
        ),
      ).toBe(false);
    });

    it('does not match unrelated errors', () => {
      expect(isQuotaExhaustedError(new Error('Network timeout'))).toBe(false);
      expect(isQuotaExhaustedError(null)).toBe(false);
      expect(isQuotaExhaustedError(undefined)).toBe(false);
    });
  });

  describe('formatQuotaExhaustedMessage', () => {
    it('strips the leading HTTP-status prefix and keeps the reset time', () => {
      const error = Object.assign(
        new Error(
          '429 Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.',
        ),
        { status: 429 },
      );
      const message = formatQuotaExhaustedMessage(error);
      expect(message.startsWith('Quota exhausted: ')).toBe(true);
      expect(message).not.toContain('429 Your');
      expect(message).toContain('will reset at 07-27 09:25:00 UTC');
      expect(message).toContain('switch to another API key');
    });

    it('falls back when no message can be extracted', () => {
      const message = formatQuotaExhaustedMessage(42);
      expect(message.startsWith('Quota exhausted: ')).toBe(true);
      expect(message).toContain('quota has been exhausted');
    });

    it('unwraps a JSON error body to surface the nested message', () => {
      // openai-compatible providers emit 429 bodies as JSON; the friendly
      // message must show the human-readable text, not raw JSON.
      const error = new Error(
        '{"error":{"code":"429","message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.","status":"RESOURCE_EXHAUSTED","details":[]}}',
      );
      const message = formatQuotaExhaustedMessage(error);
      expect(message).toContain(
        'Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.',
      );
      expect(message).not.toContain('{"error"');
    });

    it('is idempotent — does not double-wrap its own output', () => {
      const first = formatQuotaExhaustedMessage(
        new Error(
          'Your quota has been exhausted. It will reset at 2026-07-28.',
        ),
      );
      const second = formatQuotaExhaustedMessage(new Error(first));
      expect(second).toBe(first);
    });
  });

  describe('type guards', () => {
    describe('isApiError', () => {
      it('should detect valid API error', () => {
        const error: ApiError = {
          error: {
            code: 429,
            message: 'test error',
            status: 'RESOURCE_EXHAUSTED',
            details: [],
          },
        };
        expect(isApiError(error)).toBe(true);
      });

      it('should not detect invalid API error', () => {
        const error = { message: 'test error' };
        expect(isApiError(error)).toBe(false);
      });
    });

    describe('isStructuredError', () => {
      it('should detect valid structured error', () => {
        const error = { message: 'test error', status: 429 };
        expect(isStructuredError(error)).toBe(true);
      });

      it('should not detect invalid structured error', () => {
        const error = { code: 429 };
        expect(isStructuredError(error)).toBe(false);
      });
    });
  });
});
