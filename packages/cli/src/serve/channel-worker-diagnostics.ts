/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { sanitizeLogText } from '@qwen-code/channel-base';
import stripAnsi from 'strip-ansi';
import { isCredentialName } from '../utils/credential-names.js';

const WORKER_LOG_INVISIBLE_RE = /[\p{Cf}\u2028\u2029]|\p{Variation_Selector}/gu;
// eslint-disable-next-line no-control-regex
const WORKER_LOG_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

export interface WorkerDiagnosticRedactionOptions {
  daemonToken?: string;
  workerEnv: Readonly<NodeJS.ProcessEnv>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sensitiveEnvValues(env: Readonly<NodeJS.ProcessEnv>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => isCredentialName(key) && value !== undefined)
    .flatMap(([, value]) => {
      const lines = value!.split('\n').filter((line) => line.length >= 4);
      return lines.length > 0 ? [value!, ...lines] : [value!];
    })
    .filter((value) => value.length >= 4);
}

export function normalizeWorkerDiagnostic(value: string): string {
  return stripAnsi(value)
    .replace(WORKER_LOG_INVISIBLE_RE, '')
    .replace(WORKER_LOG_CONTROL_RE, '');
}

export function createWorkerDiagnosticRedactor(
  opts: WorkerDiagnosticRedactionOptions,
): (value: string) => string {
  const secretPatterns = [
    ...new Set(
      [
        ...(opts.daemonToken ? [opts.daemonToken] : []),
        ...sensitiveEnvValues(opts.workerEnv),
      ]
        .flatMap((secret) => [
          normalizeWorkerDiagnostic(secret),
          normalizeWorkerDiagnostic(secret.replace(/\t/gu, ' ')),
        ])
        .filter((secret) => secret.length >= 4),
    ),
  ]
    .sort((left, right) => right.length - left.length)
    .map((secret) => new RegExp(escapeRegExp(secret), 'g'));

  return (value: string): string => {
    let redacted = value;
    for (const secretPattern of secretPatterns) {
      redacted = redacted.replace(secretPattern, '<redacted>');
    }
    return redactLogCredentials(redacted);
  };
}

export function sanitizeWorkerDiagnostic(
  value: string,
  maxLength: number,
  opts: WorkerDiagnosticRedactionOptions,
): string {
  const normalized = normalizeWorkerDiagnostic(value);
  const redacted = createWorkerDiagnosticRedactor(opts)(normalized);
  return sanitizeLogText(redacted, maxLength);
}
