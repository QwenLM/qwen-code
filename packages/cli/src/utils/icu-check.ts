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
 * data package (RHEL/Fedora ship it as `nodejs-full-i18n`), the constructor
 * succeeds silently and the first `.segment()` call dereferences the missing
 * break-iterator data: the coredump lands in
 * `Builtin_SegmenterPrototypeSegment`, and the relaunch loop turns it into a
 * silent return to the shell. Probe a real segmentation in a throwaway child
 * before that import so a broken host gets an actionable error instead of a
 * SIGSEGV (#11747).
 */

const PROBE_SOURCE =
  '[...new Intl.Segmenter("en", { granularity: "grapheme" }).segment("q")];';

const ICU_ERROR_MESSAGE = [
  'Qwen Code cannot start the interactive UI: this Node.js runtime is missing',
  'full ICU data, and segmenting text with Intl.Segmenter crashes the process.',
  'Install the full ICU package for your Node distribution',
  '(e.g. `sudo dnf install nodejs-full-i18n` on RHEL) or use a Node build',
  'with full-icu, then run qwen again.',
].join(' ');

type Probe = (command: string, args: string[]) => { status: number | null };

const defaultProbe: Probe = (command, args) => {
  // An inherited NODE_OPTIONS with a failing --require/--import would crash
  // the child for reasons unrelated to ICU and produce a wrong diagnosis.
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  return spawnSync(command, args, { stdio: 'ignore', env });
};

/** True when a recorded icu_small value means the runtime might lack full ICU. */
export function icuSmallNeedsProbe(icuSmall: unknown): boolean {
  // Official and full-icu builds report icu_small as false and skip the child
  // entirely. Probe on any other value: small-icu builds (true, the RHEL
  // failure case) and builds that don't record the key at all (unknown, probe
  // to be safe).
  return icuSmall !== false && icuSmall !== 'false';
}

/** True when the runtime might lack full ICU and needs the child probe. */
function needsProbe(): boolean {
  // Guard the Intl binding itself first: on a no-icu build the namespace may
  // not exist at all, and `typeof Intl.Segmenter` would throw ReferenceError
  // instead of reporting the missing segmenter.
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter === 'undefined') {
    return true;
  }
  // Node records its build-time ICU shape in process.config.variables.
  const variables = process.config.variables as Record<string, unknown>;
  return icuSmallNeedsProbe(variables['icu_small']);
}

/** Launch args for the probe child: forward an --icu-data-dir the user passed. */
function probeArgs(): string[] {
  // A user who repairs ICU with Node's own --icu-data-dir has a working
  // parent; the child must see the same data directory or it faults and
  // misdiagnoses the host as ICU-less. Both the space and = forms occur.
  const execArgv = process.execArgv;
  const icuArgs: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if (arg === undefined) continue;
    if (arg === '--icu-data-dir' && execArgv[i + 1] !== undefined) {
      icuArgs.push(arg, execArgv[i + 1]!);
      i++;
    } else if (arg.startsWith('--icu-data-dir=')) {
      icuArgs.push(arg);
    }
  }
  return [...icuArgs, '-e', PROBE_SOURCE];
}

export function assertFullIcuAvailable(probe: Probe = defaultProbe): void {
  if (!needsProbe()) {
    return;
  }
  let status: number | null;
  try {
    status = probe(process.execPath, probeArgs()).status;
  } catch {
    status = null;
  }
  if (status !== 0) {
    writeStderrLine(ICU_ERROR_MESSAGE);
    process.exit(1);
  }
}
