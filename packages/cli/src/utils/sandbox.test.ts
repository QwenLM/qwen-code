/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseSandboxImageName } from './sandboxImageName.js';

describe('parseSandboxImageName', () => {
  it('uses the image basename and tag for container names', () => {
    expect(parseSandboxImageName('ghcr.io/qwenlm/qwen-code:0.18.3')).toBe(
      'qwen-code-0.18.3',
    );
  });

  it('handles registry ports without treating them as tags', () => {
    expect(
      parseSandboxImageName('localhost:5000/team/qwen-code-sandbox:dev'),
    ).toBe('qwen-code-sandbox-dev');
  });

  it('handles registry ports when the image is untagged', () => {
    expect(parseSandboxImageName('localhost:5000/team/qwen-code-sandbox')).toBe(
      'qwen-code-sandbox',
    );
  });

  it('drops digests from generated container names', () => {
    expect(
      parseSandboxImageName(
        'registry.example.com/team/qwen-code-sandbox@sha256:abcdef',
      ),
    ).toBe('qwen-code-sandbox');
  });

  it('keeps tags when dropping digests from generated container names', () => {
    expect(
      parseSandboxImageName(
        'registry.example.com/team/qwen-code-sandbox:dev@sha256:abcdef',
      ),
    ).toBe('qwen-code-sandbox-dev');
  });
});
