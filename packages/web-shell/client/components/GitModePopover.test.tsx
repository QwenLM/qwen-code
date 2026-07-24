/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { validateBranchName } from './GitModePopover';

// Shared test vectors — the same inputs are asserted on the server side
// in packages/cli/src/serve/server.test.ts (POST /session branch validation).
// If either predicate drifts, these tests catch it.
describe('validateBranchName', () => {
  it.each([
    'feat/../x',
    'feat//x',
    'feat@{1}',
    'feat.lock',
    '.hidden',
    '-feat',
    'HEAD',
    'feature.git',
    '',
  ])('rejects %s', (name) => {
    expect(validateBranchName(name)).toBe(false);
  });

  it.each(['feat/x', 'fix/bug-123', 'my-branch', 'release/v1.0.0', 'a'])(
    'accepts %s',
    (name) => {
      expect(validateBranchName(name)).toBe(true);
    },
  );

  it('rejects names exceeding the byte-length caps', () => {
    // Mirrors the server-side caps (200 bytes per `/`-separated component,
    // 1000 bytes total). Counted in UTF-8 bytes, so CJK chars (3 bytes each)
    // trip the component cap at ~86 chars.
    expect(validateBranchName('a'.repeat(201))).toBe(false);
    expect(validateBranchName(`feat/${'a'.repeat(201)}`)).toBe(false);
    expect(validateBranchName('a'.repeat(1001))).toBe(false);
    expect(validateBranchName('功'.repeat(86))).toBe(false);
  });

  it('accepts a name at the byte-length boundary', () => {
    expect(validateBranchName('a'.repeat(200))).toBe(true);
  });
});
