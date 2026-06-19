/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isContainerPathWithinWorkdir } from './sandbox-path.js';
import { parseSandboxImageName } from './sandboxImageName.js';

describe('isContainerPathWithinWorkdir', () => {
  it('allows the workdir itself', () => {
    expect(isContainerPathWithinWorkdir('/repo/app', '/repo/app')).toBe(true);
  });

  it('allows paths under the workdir', () => {
    expect(isContainerPathWithinWorkdir('/repo/app', '/repo/app/bin')).toBe(
      true,
    );
  });

  it('rejects sibling paths with the same prefix', () => {
    expect(
      isContainerPathWithinWorkdir('/repo/app', '/repo/app-tools/bin'),
    ).toBe(false);
  });

  it('allows absolute paths under the filesystem root workdir', () => {
    expect(isContainerPathWithinWorkdir('/', '/bin')).toBe(true);
  });

  it('normalizes trailing slashes and case for container paths', () => {
    expect(
      isContainerPathWithinWorkdir('/C/Repo/App/', '/c/repo/app/bin'),
    ).toBe(true);
  });

  it('handles converted Windows drive roots without matching sibling drives', () => {
    expect(isContainerPathWithinWorkdir('/c', '/c/tools')).toBe(true);
    expect(isContainerPathWithinWorkdir('/c', '/c2/tools')).toBe(false);
  });
});

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
