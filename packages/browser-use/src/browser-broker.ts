#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserBroker } from './broker/browser-broker.js';

const IDLE_TIMEOUT_MS = 30_000;

let idleTimer: NodeJS.Timeout | undefined;
let stopping: Promise<void> | undefined;

const broker = new BrowserBroker({
  onClientCountChanged(clientCount) {
    if (clientCount === 0) scheduleIdleExit();
    else clearIdleTimer();
  },
});

await broker.start();
scheduleIdleExit();

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

function scheduleIdleExit(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => void shutdown(), IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

function clearIdleTimer(): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = undefined;
}

async function shutdown(): Promise<void> {
  stopping ??= (async () => {
    clearIdleTimer();
    await broker.stop();
  })();
  await stopping;
}
