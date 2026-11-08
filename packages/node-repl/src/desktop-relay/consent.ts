/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';

/**
 * The person at this computer decides, not the remote page: every connection
 * is approved in a native dialog, which a web page cannot draw or click.
 */

export type RunOsascript = (
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runOsascript: RunOsascript = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      args,
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

const DIALOG_SECONDS = 60;

/** Script lines passed with `-e`; the message arrives as `argv` so it needs no quoting. */
function script(lines: string[], message: string): string[] {
  return [...lines.flatMap((line) => ['-e', line]), message];
}

/**
 * Resolves true only for an explicit Allow; Deny, time-out and errors refuse.
 * A dialog that could not run (osascript missing, blocked, or erroring) is
 * reported on stderr — the log a launchd-spawned relay is diagnosed through —
 * because the caller can only present a refusal, and a failure is not one.
 */
export async function askConsent(
  message: string,
  run: RunOsascript = runOsascript,
): Promise<boolean> {
  const { code, stdout, stderr } = await run(
    script(
      [
        'on run argv',
        'activate',
        `display dialog (item 1 of argv) with title "Qwen Code" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after ${DIALOG_SECONDS}`,
        'return (button returned of result) & "|" & (gave up of result)',
        'end run',
      ],
      message,
    ),
    (DIALOG_SECONDS + 10) * 1000,
  );
  const answer = stdout.trim();
  if (code === 0 && answer === 'Allow|false') return true;
  // Deny is the cancel button, which osascript reports as "User canceled.
  // (-128)"; a dialog nobody answered returns `...|true` after giving up.
  const refused = stderr.includes('-128') || (code === 0 && answer !== '');
  if (!refused) {
    process.stderr.write(
      `desktop-relay: consent dialog failed (exit ${String(code)}): ${
        stderr.trim() || answer || 'no output'
      }\n`,
    );
  }
  return false;
}

export async function notify(
  message: string,
  run: RunOsascript = runOsascript,
): Promise<void> {
  await run(
    script(
      [
        'on run argv',
        'display notification (item 1 of argv) with title "Qwen Code"',
        'end run',
      ],
      message,
    ),
    10_000,
  );
}
