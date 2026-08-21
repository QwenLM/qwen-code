/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DASHSCOPE_NATIVE_GENERATION_PATH,
  DEFAULT_DASHSCOPE_NATIVE_BASE_URL,
  resolveDashScopeGenerationEndpoint,
} from './endpoints.js';

const EXPECTED_DEFAULT_ENDPOINT = `${DEFAULT_DASHSCOPE_NATIVE_BASE_URL}/${DASHSCOPE_NATIVE_GENERATION_PATH}`;

describe('resolveDashScopeGenerationEndpoint', () => {
  it('defaults to the Singapore base URL when undefined', () => {
    expect(resolveDashScopeGenerationEndpoint(undefined)).toBe(
      EXPECTED_DEFAULT_ENDPOINT,
    );
  });

  it('defaults to the Singapore base URL when empty', () => {
    expect(resolveDashScopeGenerationEndpoint('')).toBe(
      EXPECTED_DEFAULT_ENDPOINT,
    );
  });

  it('appends the generation path to an /api/v1 base URL', () => {
    expect(
      resolveDashScopeGenerationEndpoint(
        'https://dashscope.aliyuncs.com/api/v1',
      ),
    ).toBe(
      `https://dashscope.aliyuncs.com/api/v1/${DASHSCOPE_NATIVE_GENERATION_PATH}`,
    );
  });

  it('strips a trailing slash without producing a double slash', () => {
    expect(
      resolveDashScopeGenerationEndpoint(
        'https://dashscope-intl.aliyuncs.com/api/v1/',
      ),
    ).toBe(EXPECTED_DEFAULT_ENDPOINT);
  });

  it('handles a long slash run followed by a non-slash character', () => {
    const baseUrl = `https://example.com/${'/'.repeat(10_000)}models`;
    expect(resolveDashScopeGenerationEndpoint(baseUrl)).toBe(
      `${baseUrl}/api/v1/${DASHSCOPE_NATIVE_GENERATION_PATH}`,
    );
  });

  it('appends /api/v1 to a bare host', () => {
    expect(
      resolveDashScopeGenerationEndpoint('https://dashscope-intl.aliyuncs.com'),
    ).toBe(EXPECTED_DEFAULT_ENDPOINT);
  });

  it('replaces a pasted /compatible-mode/v1 compat URL with /api/v1', () => {
    expect(
      resolveDashScopeGenerationEndpoint(
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      ),
    ).toBe(EXPECTED_DEFAULT_ENDPOINT);
  });

  it('does not duplicate /api/v1 for a compat URL already rooted at /api/v1', () => {
    expect(
      resolveDashScopeGenerationEndpoint(
        'https://dashscope-intl.aliyuncs.com/api/v1/compatible-mode/v1',
      ),
    ).toBe(EXPECTED_DEFAULT_ENDPOINT);
  });

  it('does not duplicate /api/v1 for a compat URL with a doubled slash', () => {
    expect(
      resolveDashScopeGenerationEndpoint(
        'https://dashscope-intl.aliyuncs.com/api/v1//compatible-mode/v1',
      ),
    ).toBe(EXPECTED_DEFAULT_ENDPOINT);
  });

  it('returns a full endpoint ending in /generation unchanged', () => {
    const fullEndpoint = `https://dashscope-intl.aliyuncs.com/api/v1/${DASHSCOPE_NATIVE_GENERATION_PATH}`;
    expect(resolveDashScopeGenerationEndpoint(fullEndpoint)).toBe(fullEndpoint);
  });

  it('returns a full endpoint with a trailing slash stripped and unchanged', () => {
    const fullEndpoint = `https://dashscope-intl.aliyuncs.com/api/v1/${DASHSCOPE_NATIVE_GENERATION_PATH}`;
    expect(resolveDashScopeGenerationEndpoint(`${fullEndpoint}/`)).toBe(
      fullEndpoint,
    );
  });

  it('falls back to string-suffix logic when the URL fails to parse', () => {
    expect(resolveDashScopeGenerationEndpoint('not a url /api/v1')).toBe(
      `not a url /api/v1/${DASHSCOPE_NATIVE_GENERATION_PATH}`,
    );
  });
});
