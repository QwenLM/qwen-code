/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { rewindCommand } from './rewindCommand.js';
import type { CommandContext } from './types.js';

describe('rewindCommand', () => {
  it('keeps active-leaf navigation input out of the transcript', () => {
    expect(rewindCommand.omitInputFromTranscript).toBe(true);
  });

  it('opens the rewind selector', async () => {
    await expect(
      rewindCommand.action?.({} as CommandContext, ''),
    ).resolves.toEqual({
      type: 'dialog',
      dialog: 'rewind',
    });
  });
});
