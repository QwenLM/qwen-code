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
