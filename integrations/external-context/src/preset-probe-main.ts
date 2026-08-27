/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parsePresetProbeArgs,
  renderPresetProbeReport,
  runPresetProbe,
} from './preset-probe.js';
import { installEnvironmentProxy } from './proxy.js';

const PROBE_TIMEOUT_MS = 30_000;

try {
  installEnvironmentProxy();
  const options = parsePresetProbeArgs(process.argv.slice(2), process.env);
  const report = await runPresetProbe({
    ...options,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  process.stdout.write(renderPresetProbeReport(report));
  process.exitCode =
    report.verdict === 'preset-mismatch' || report.verdict === 'empty-corpus'
      ? 1
      : 0;
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Preset probe failed.';
  process.stderr.write(`[external-context] ${message}\n`);
  process.exitCode = 2;
}
