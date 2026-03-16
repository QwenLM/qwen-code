/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveCommandSelectionAction } from './commandSelectionBehavior.js';

describe('resolveCommandSelectionAction', () => {
  it('keeps /login as an immediate action', () => {
    expect(resolveCommandSelectionAction('login', [])).toEqual({
      kind: 'execute-login',
    });
  });

  it('keeps /model as an immediate action', () => {
    expect(resolveCommandSelectionAction('model', [])).toEqual({
      kind: 'open-model-selector',
    });
  });

  it('inserts server-provided slash commands instead of submitting them', () => {
    expect(
      resolveCommandSelectionAction('create-issue', [
        { name: 'create-issue' },
        { name: 'export' },
      ]),
    ).toEqual({
      kind: 'insert',
    });
  });

  it('defaults unknown commands to insertion only', () => {
    expect(resolveCommandSelectionAction('custom-command', [])).toEqual({
      kind: 'insert',
    });
  });
});
