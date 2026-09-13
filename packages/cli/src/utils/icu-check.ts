/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';

import { writeStderrLine } from './stdioHelpers.js';

/**
 * The interactive UI creates an `Intl.Segmenter` at module load
 * (`ui/utils/textUtils.ts`). On a Node runtime built with small-icu and no
 * data package (RHEL ships one as `nodejs-full-i18n`), that V8 call segfaults
 * the process, and the relaunch loop turns it into a silent return to the
 * shell. Probe the runtime in a throwaway child before that import so a
 * broken host gets an actionable error instead of a SIGSEGV (#11747).
 */

const PROBE_SOURCE = 'new Intl.Segmenter("en");';

const ICU_ERROR_MESSAGE = [
  'Qwen Code cannot start the interactive UI: this Node.js runtime is missing',
  'full ICU data, and creating an Intl.Segmenter crashes the process.',
  'Install the full ICU package for your Node distribution',
  '(e.g. `sudo dnf install nodejs-full-i18n` on RHEL) or use a Node build',
  'with full-icu, then run qwen again.',
].join(' ');

type Probe = (command: string, args: string[]) => { status: number | null };

const defaultProbe: Probe = (command, args) =>
  spawnSync(command, args, { stdio: 'ignore' });

/** True when the runtime might lack full ICU and needs the child probe. */
function needsProbe(): boolean {
  if (typeof Intl.Segmenter === 'undefined') {
    return true;
  }
  // Node records its build-time ICU shape in process.config; small-icu with
  // no data package is the failing case, so only those hosts pay for a child.
  // The typed config shape omits icu_small, but every real build reports it.
  const variables = process.config.variables as Record<string, unknown>;
  const icuSmall = variables['icu_small'];
  return icuSmall === true || icuSmall === 'true';
}

export function assertFullIcuAvailable(probe: Probe = defaultProbe): void {
  if (!needsProbe()) {
    return;
  }
  let status: number | null;
  try {
    status = probe(process.execPath, ['-e', PROBE_SOURCE]).status;
  } catch {
    status = null;
  }
  if (status !== 0) {
    writeStderrLine(ICU_ERROR_MESSAGE);
    process.exit(1);
  }
}
