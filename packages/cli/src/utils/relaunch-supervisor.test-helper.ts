/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs twice: first as a supervisor that relaunches this file, then as the
// supervised child. The child reports its pid and exit code, and keeps working
// until something stops it, or with `idle` has nothing left to do. With
// `late`, it reports first and starts watching its supervisor a second later.
// With `graceful`, it shuts down on SIGTERM and reports that it did.
import {
  exitWhenSupervisorExits,
  relaunchAppInChildProcess,
} from './relaunch.js';

if (process.env['QWEN_CODE_NO_RELAUNCH']) {
  process.on('exit', (code) => process.stdout.write(`exit:${code}\n`));
  if (process.argv.includes('graceful')) {
    process.once('SIGTERM', () => {
      process.stdout.write('graceful-shutdown\n');
      setTimeout(() => process.exit(0), 100);
    });
  }
  const late = process.argv.includes('late');
  if (late) {
    process.stdout.write(`child-pid:${process.pid}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  exitWhenSupervisorExits(200);
  if (!process.argv.includes('idle')) setInterval(() => {}, 1_000);
  if (!late) process.stdout.write(`child-pid:${process.pid}\n`);
} else {
  await relaunchAppInChildProcess([], []);
}
