/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared report primitives for daemon performance test suites (baseline,
 * benchmark, loadtest). Each suite owns its own SnapshotShape and
 * renderMarkdown; this module provides the common building blocks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Percentiles } from './_daemon-harness.js';

// ---------------------------------------------------------------------------
// Platform info
// ---------------------------------------------------------------------------

export interface PlatformInfo {
  os: string;
  arch: string;
  nodeVersion: string;
}

export function collectPlatformInfo(): PlatformInfo {
  return {
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };
}

// ---------------------------------------------------------------------------
// Output directory resolution
// ---------------------------------------------------------------------------

export function resolveOutputDir(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace(/Z$/, '');
  return (
    process.env['INTEGRATION_TEST_FILE_DIR'] ??
    path.join(process.cwd(), '.integration-tests', `${label}-${ts}`)
  );
}

// ---------------------------------------------------------------------------
// Percentile formatting
// ---------------------------------------------------------------------------

export function formatPercentiles(p: Percentiles | null | undefined): string {
  return p && p.count > 0
    ? `p50=${p.p50.toFixed(0)} p90=${p.p90.toFixed(0)} p99=${p.p99.toFixed(0)} mean=${p.mean.toFixed(0)} (n=${p.count})`
    : 'n/a';
}

// ---------------------------------------------------------------------------
// Snapshot artifact writer
// ---------------------------------------------------------------------------

export function writeSnapshotArtifacts(
  outputDir: string,
  baseName: string,
  snapshot: unknown,
  markdown: string,
  logTag: string,
): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(path.join(outputDir, `${baseName}.md`), markdown);
  console.log(`[${logTag}] ${baseName}.json written to ${jsonPath}`);
}
