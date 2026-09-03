/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { acpChildExtraArgs } from './acp-child-extra-args.js';

describe('acpChildExtraArgs', () => {
  it('returns undefined when no child flags are set', () => {
    expect(acpChildExtraArgs({})).toBeUndefined();
    expect(acpChildExtraArgs({ experimentalLsp: false })).toBeUndefined();
    expect(
      acpChildExtraArgs({ restoreAskUserQuestion: false }),
    ).toBeUndefined();
  });

  it('merges lsp and restore flags in spawn order', () => {
    expect(acpChildExtraArgs({ experimentalLsp: true })).toEqual([
      '--experimental-lsp',
    ]);
    expect(acpChildExtraArgs({ restoreAskUserQuestion: true })).toEqual([
      '--restore-ask-user-question',
    ]);
    expect(
      acpChildExtraArgs({
        experimentalLsp: true,
        restoreAskUserQuestion: true,
      }),
    ).toEqual(['--experimental-lsp', '--restore-ask-user-question']);
  });
});
