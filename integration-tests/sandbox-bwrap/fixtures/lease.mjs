/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { setInterval } from 'node:timers';
import { pathToFileURL } from 'node:url';

const [modulePath, sessionId, transcriptPath, mode, pidFile] =
  process.argv.slice(2);
const { SessionWriterLease, SessionWriterError } = await import(
  pathToFileURL(modulePath).href
);
try {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: process.env.QWEN_RUNTIME_DIR,
    sessionId,
    transcriptPath,
    processKind: 'acp',
    reclaimPolicy: 'local',
  });
  await lease.appendJsonLine({ writer: mode });
  const owner = { pid: process.pid, ownerId: lease.ownerId };
  if (mode === 'hold') {
    writeFileSync(pidFile, JSON.stringify(owner));
    setInterval(() => {}, 1_000);
  } else {
    await lease.release();
    console.log(JSON.stringify(owner));
  }
} catch (error) {
  if (!(error instanceof SessionWriterError)) throw error;
  console.error(error.errorKind);
  process.exitCode = 23;
}
