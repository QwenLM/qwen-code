/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { freemem, totalmem } from 'node:os';

export interface ProcessResourceSnapshot {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  systemFreeMb: number;
  systemTotalMb: number;
}

const cachedTotalMem = bytesToRoundedMb(totalmem());

export function getProcessResourceSnapshot():
  | ProcessResourceSnapshot
  | undefined {
  try {
    const memory = process.memoryUsage();
    return {
      rssMb: bytesToRoundedMb(memory.rss),
      heapUsedMb: bytesToRoundedMb(memory.heapUsed),
      heapTotalMb: bytesToRoundedMb(memory.heapTotal),
      externalMb: bytesToRoundedMb(memory.external),
      arrayBuffersMb: bytesToRoundedMb(memory.arrayBuffers),
      systemFreeMb: bytesToRoundedMb(freemem()),
      systemTotalMb: cachedTotalMem,
    };
  } catch {
    return undefined;
  }
}

function bytesToRoundedMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}
