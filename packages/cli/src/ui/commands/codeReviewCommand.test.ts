/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { codeReviewCommand } from './codeReviewCommand.js';
import { CommandKind } from './types.js';

describe('codeReviewCommand', () => {
  it('should have the correct name and description', () => {
    expect(codeReviewCommand.name).toBe('code-review');
    expect(codeReviewCommand.description).toBe('Submit code for AI review');
    expect(codeReviewCommand.kind).toBe(CommandKind.BUILT_IN);
  });
});
