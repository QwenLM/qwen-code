/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { findProjectRoot } from './memoryDiscovery.js';
import { normalizePath } from './paths.js';
import type { AgentsMdSizePolicy } from '../config-service/features/agentsMdSizePolicy.js';

export interface AgentsMdSizeFile {
  path: string;
  bytes: number;
  depth: number;
}

export interface AgentsMdSizeMeasurement {
  files: AgentsMdSizeFile[];
  totalBytes: number;
  measuredAt: number;
  loadStatus: 'complete' | 'absent' | 'partial' | 'blocked';
  readErrorCount: number;
}

export interface AgentsMdSizeSnapshot extends AgentsMdSizeMeasurement {
  thresholdBytes: number;
  thresholdSource: AgentsMdSizePolicy['source'];
  thresholdReached: boolean;
  reason: 'startup' | 'refresh' | 'qcs_update';
}

/** Raw project root -> cwd instruction chain only; one selected file per directory.
 * User/local/rules/imports/JIT/extra workspace roots never consume this budget.
 * Measurement does not change the instruction loader or truncate any content.
 */
export async function measureAgentsMdSize(options: {
  cwd: string;
  boundaryMarkers: readonly string[];
  fallbackFilenames: readonly string[];
  allowed: boolean;
  isExcluded?: (file: string) => boolean;
}): Promise<AgentsMdSizeMeasurement> {
  const measurement: AgentsMdSizeMeasurement = {
    files: [],
    totalBytes: 0,
    measuredAt: Date.now(),
    loadStatus: options.allowed ? 'absent' : 'blocked',
    readErrorCount: 0,
  };
  if (!options.allowed) return measurement;
  const cwd = path.resolve(options.cwd);
  const root = (await findProjectRoot(cwd, options.boundaryMarkers)) ?? cwd;
  const directories = [cwd];
  while (normalizePath(directories[0]) !== normalizePath(root)) {
    const parent = path.dirname(directories[0]);
    if (parent === directories[0]) break;
    directories.unshift(parent);
  }
  const filenames = [
    ...new Set([
      'AGENTS.override.md',
      'AGENTS.md',
      ...options.fallbackFilenames,
    ]),
  ].filter(
    (name) =>
      name.length > 0 &&
      name !== '.' &&
      name !== '..' &&
      path.basename(name) === name,
  );
  for (const [depth, directory] of directories.entries()) {
    for (const filename of filenames) {
      const file = path.join(directory, filename);
      if (options.isExcluded?.(file)) continue;
      try {
        if (!(await fs.stat(file)).isFile()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          measurement.readErrorCount++;
        continue;
      }
      try {
        const content = await fs.readFile(file);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        if (text.trim().length > 0) {
          measurement.files.push({
            path: file,
            bytes: content.byteLength,
            depth,
          });
          measurement.totalBytes += content.byteLength;
        }
      } catch {
        measurement.readErrorCount++;
      }
      // A selected empty/unreadable file does not cause fallback selection.
      break;
    }
  }
  measurement.loadStatus =
    measurement.readErrorCount > 0
      ? 'partial'
      : measurement.files.length > 0
        ? 'complete'
        : 'absent';
  return measurement;
}

export function evaluateAgentsMdSize(
  measurement: AgentsMdSizeMeasurement,
  policy: AgentsMdSizePolicy,
  reason: AgentsMdSizeSnapshot['reason'],
): AgentsMdSizeSnapshot {
  return {
    ...measurement,
    thresholdBytes: policy.projectDocMaxBytes,
    thresholdSource: policy.source,
    thresholdReached:
      measurement.loadStatus !== 'blocked' &&
      measurement.totalBytes >= policy.projectDocMaxBytes,
    reason,
  };
}

export function formatAgentsMdSizeWarning(
  snapshot: AgentsMdSizeSnapshot,
): string {
  return (
    `Project AGENTS.md instruction chain reached the size budget (${snapshot.totalBytes.toLocaleString()} bytes >= ${snapshot.thresholdBytes.toLocaleString()} bytes). Large instructions may impact performance. This warning does not truncate content; consider shortening these files:\n` +
    snapshot.files
      .map((file) => `  ${file.path} (${file.bytes.toLocaleString()} bytes)`)
      .join('\n')
  );
}
