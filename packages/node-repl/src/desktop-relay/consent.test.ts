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

  it('activates before prompting and passes the message without script interpolation', async () => {
    const run = runner({ code: 0, stdout: 'Allow|false' });
    const message = 'evil" & do shell script "rm -rf ~" & "';
    await askConsent(message, run);
    const args = run.mock.calls[0]?.[0] ?? [];
    const activate = args.indexOf('activate');
    const dialog = args.findIndex((arg) => arg.startsWith('display dialog '));
    expect(activate).toBeGreaterThan(-1);
    expect(activate).toBeLessThan(dialog);
    expect(args[dialog]).toContain('default button "Deny"');
    expect(args[dialog]).toContain('cancel button "Deny"');
    expect(args[dialog]).toContain('giving up after 60');
    expect(run.mock.calls[0]?.[1]).toBe(70_000);
    expect(args.at(-1)).toBe(message);
    expect(args.slice(0, -1).join('\n')).not.toContain('rm -rf');
  });
});
