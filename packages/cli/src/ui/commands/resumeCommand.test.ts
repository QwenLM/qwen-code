/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resumeCommand } from './resumeCommand.js';
import type { CommandContext } from './types.js';

describe('resumeCommand', () => {
  it('keeps navigation input out of the transcript', () => {
    expect(resumeCommand.omitInputFromTranscript).toBe(true);
  });

  it('should open the session browser for bare /resume', async () => {
    const result = await resumeCommand.action?.({} as CommandContext, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'sessionBrowser',
      props: {
        resumeTarget: undefined,
      },
    });
  });

  it('should pass the resume target through for /resume <arg>', async () => {
    const result = await resumeCommand.action?.(
      {} as CommandContext,
      'session-123',
    );
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'sessionBrowser',
      props: {
        resumeTarget: 'session-123',
      },
    });
  });

  it('should not expose legacy resume subcommands', () => {
    expect(resumeCommand.subCommands).toBeUndefined();
  });
});
