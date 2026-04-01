/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';

/**
 * File-modifying tool names that should trigger post-edit verification.
 */
const EDIT_TOOLS = new Set(['write_file', 'edit', 'replace']);

/**
 * Check whether any completed tool calls modified files.
 */
export function hasFileEdits(toolNames: Iterable<string>): boolean {
  for (const name of toolNames) {
    if (EDIT_TOOLS.has(name)) return true;
  }
  return false;
}

/**
 * Run a post-edit verification command and return the result as context
 * for the model. Returns null if no command is configured or if the
 * command succeeds silently.
 *
 * The model sees verification failures immediately alongside tool
 * results, enabling self-correction without a new turn. This implements
 * the "separate evaluator" pattern from harness engineering.
 */
export async function runPostEditVerify(
  cwd: string,
  verifyCommand?: string | null,
): Promise<string | null> {
  if (!verifyCommand) return null;

  const parts = verifyCommand.split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);

  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: 30_000, maxBuffer: 1024 * 100 },
      (error, stdout, stderr) => {
        if (!error) {
          // Verification passed — no need to inject anything
          resolve(null);
          return;
        }

        // Verification failed — build the context for the model
        const output = (stderr || stdout || '').trim();
        const truncated =
          output.length > 2000
            ? output.slice(0, 2000) + '\n...(truncated)'
            : output;

        resolve(
          `[Post-edit verification FAILED — \`${verifyCommand}\` exited ${error.code ?? 'non-zero'}]\n${truncated}\n[Fix the issue before continuing]`,
        );
      },
    );
  });
}
