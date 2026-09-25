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
) => Promise<{ code: number; stdout: string }>;

export const runOsascript: RunOsascript = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      args,
      { timeout: timeoutMs },
      (error, stdout) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1;
        resolve({ code, stdout: String(stdout) });
      },
    );
  });

const DIALOG_SECONDS = 60;

/** Script lines passed with `-e`; the message arrives as `argv` so it needs no quoting. */
function script(lines: string[], message: string): string[] {
  return [...lines.flatMap((line) => ['-e', line]), message];
}

/** Resolves true only for an explicit Allow; Deny, time-out and errors refuse. */
export async function askConsent(
  message: string,
  run: RunOsascript = runOsascript,
): Promise<boolean> {
  const { code, stdout } = await run(
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
  return code === 0 && stdout.trim() === 'Allow|false';
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
