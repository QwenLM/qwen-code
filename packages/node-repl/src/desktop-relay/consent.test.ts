/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { askConsent, type RunOsascript } from './consent.js';

function runner(result: { code: number; stdout: string }) {
  return vi.fn<RunOsascript>(async () => result);
}

describe('askConsent', () => {
  it('allows only on an explicit Allow', async () => {
    await expect(
      askConsent('m', runner({ code: 0, stdout: 'Allow|false\n' })),
    ).resolves.toBe(true);
  });

  it('refuses on Deny, on time-out and on failure', async () => {
    // Deny is the cancel button, which osascript reports as an error.
    await expect(
      askConsent('m', runner({ code: 1, stdout: '' })),
    ).resolves.toBe(false);
    await expect(
      askConsent('m', runner({ code: 0, stdout: '|true\n' })),
    ).resolves.toBe(false);
  });

  it('passes the message as an argument instead of splicing it into the script', async () => {
    const run = runner({ code: 0, stdout: 'Allow|false' });
    const message = 'evil" & do shell script "rm -rf ~" & "';
    await askConsent(message, run);
    const args = run.mock.calls[0]?.[0] ?? [];
    expect(args.at(-1)).toBe(message);
    expect(args.slice(0, -1).join('\n')).not.toContain('rm -rf');
  });
});
