/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';

/**
 * Pre-flight baseline check results. Run once at session start to
 * establish the project's state before the agent touches anything.
 * Surfaces dirty working trees, recent commits, and optional
 * user-configured verification commands.
 */
export interface BaselineResult {
  branch: string | null;
  isDirty: boolean;
  dirtyFiles: string[];
  recentCommits: string[];
  verifyCommand: string | null;
  verifyPassed: boolean | null;
  verifyOutput: string | null;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 10_000 }, (error, stdout) => {
      resolve({
        stdout: (stdout ?? '').trim(),
        exitCode: error
          ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1)
          : 0,
      });
    });
  });
}

/**
 * Run a lightweight baseline check on the project at `cwd`.
 *
 * - Git branch + dirty status (always)
 * - Recent commits (always)
 * - Optional verification command from settings (e.g. `npm run build`)
 *
 * Returns within ~10s worst case (verification command timeout).
 * Never throws — failures are captured in the result.
 */
export async function runBaselineCheck(
  cwd: string,
  verifyCommand?: string,
): Promise<BaselineResult> {
  const [branchResult, statusResult, logResult] = await Promise.all([
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    run('git', ['status', '--porcelain'], cwd),
    run('git', ['log', '--oneline', '-5'], cwd),
  ]);

  const branch = branchResult.exitCode === 0 ? branchResult.stdout : null;

  const dirtyFiles =
    statusResult.exitCode === 0 && statusResult.stdout.length > 0
      ? statusResult.stdout.split('\n').filter(Boolean)
      : [];

  const recentCommits =
    logResult.exitCode === 0 && logResult.stdout.length > 0
      ? logResult.stdout.split('\n').filter(Boolean)
      : [];

  let verifyPassed: boolean | null = null;
  let verifyOutput: string | null = null;

  if (verifyCommand) {
    const parts = verifyCommand.split(/\s+/);
    const verifyResult = await run(parts[0]!, parts.slice(1), cwd);
    verifyPassed = verifyResult.exitCode === 0;
    verifyOutput = verifyResult.stdout.slice(0, 500);
  }

  return {
    branch,
    isDirty: dirtyFiles.length > 0,
    dirtyFiles,
    recentCommits,
    verifyCommand: verifyCommand ?? null,
    verifyPassed,
    verifyOutput,
  };
}

/**
 * Format a baseline result as a concise string for the system prompt
 * or an info message.
 */
export function formatBaseline(result: BaselineResult): string {
  const lines: string[] = [];

  if (result.branch) {
    lines.push(`Branch: ${result.branch}`);
  }

  if (result.isDirty) {
    const count = result.dirtyFiles.length;
    const preview = result.dirtyFiles
      .slice(0, 5)
      .map((f) => `  ${f}`)
      .join('\n');
    const suffix = count > 5 ? `\n  ... (+${count - 5} more)` : '';
    lines.push(`Working tree: ${count} dirty file(s)\n${preview}${suffix}`);
  } else {
    lines.push('Working tree: clean');
  }

  if (result.recentCommits.length > 0) {
    lines.push(
      `Recent commits:\n${result.recentCommits.map((c) => `  ${c}`).join('\n')}`,
    );
  }

  if (result.verifyCommand && result.verifyPassed !== null) {
    const status = result.verifyPassed ? 'PASSED' : 'FAILED';
    lines.push(`Verify (${result.verifyCommand}): ${status}`);
    if (!result.verifyPassed && result.verifyOutput) {
      lines.push(result.verifyOutput);
    }
  }

  return lines.join('\n');
}
