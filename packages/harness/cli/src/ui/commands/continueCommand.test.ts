/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { continueCommand } from './continueCommand.js';
import type { CommandContext } from './types.js';

describe('continueCommand', () => {
  it('keeps navigation input out of the transcript', () => {
    expect(continueCommand.omitInputFromTranscript).toBe(true);
  });

  it('should request continuing the latest session', async () => {
    const result = await continueCommand.action?.({} as CommandContext, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'sessionBrowser',
      props: {
        continueLatest: true,
      },
    });
  });
});
