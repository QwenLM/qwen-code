/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const AUDIT_ARGS = ['audit', '--omit=dev', '--audit-level=critical', '--json'];

/**
 * Decide what `npm audit --json` actually told us.
 *
 * npm exits 1 both when it finds a critical vulnerability and when it never
 * reached the registry, so the exit code alone cannot gate a merge: treating
 * every non-zero as "vulnerable" blocks the whole repository on an npm outage,
 * and treating it as "fine" silently disables the gate. The payload separates
 * them — a real audit always carries `metadata.vulnerabilities`, while a
 * transport failure carries the request error instead.
 *
 * @param {string} stdout raw stdout from `npm audit --json`
 * @returns {'audited' | 'unreachable' | 'unreadable'}
 */
export function classifyAuditOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return 'unreadable';
  }
  if (parsed?.metadata?.vulnerabilities) {
    return 'audited';
  }
  if (parsed?.error || typeof parsed?.statusCode === 'number') {
    return 'unreachable';
  }
  return 'unreadable';
}

function main() {
  const result = spawnSync('npm', AUDIT_ARGS, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const stdout = result.stdout ?? '';
  const verdict = classifyAuditOutput(stdout);

  if (verdict === 'audited') {
    const counts = JSON.parse(stdout).metadata.vulnerabilities;
    if (result.status === 0) {
      console.log(
        `No critical runtime vulnerabilities (${counts.critical} critical).`,
      );
      process.exitCode = 0;
      return;
    }
    console.error('npm audit reported vulnerabilities at or above `critical`:');
    console.error(JSON.stringify(counts, null, 2));
    process.exitCode = result.status ?? 1;
    return;
  }

  if (verdict === 'unreachable') {
    // The registry, not this repository. Warn loudly and let the build pass:
    // an npm-side outage must not gate every PR in the repo on a service we
    // do not run. A real finding still fails above.
    console.warn(
      'WARNING: npm audit could not reach the advisory endpoint, so critical runtime dependencies were NOT audited this run.',
    );
    console.warn((result.stderr ?? '').trim() || stdout.trim());
    process.exitCode = 0;
    return;
  }

  // Unrecognised output: fail closed. If npm changes its payload shape, a red
  // build gets a human to look rather than quietly retiring the gate.
  console.error(
    'npm audit produced output this checker does not recognise; failing closed.',
  );
  console.error(stdout.trim() || (result.stderr ?? '').trim());
  process.exitCode = result.status === 0 ? 1 : (result.status ?? 1);
}

// Importable for tests, executable as the npm script.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
