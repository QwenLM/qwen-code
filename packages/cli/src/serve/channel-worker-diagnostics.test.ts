/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createWorkerDiagnosticRedactor,
  normalizeWorkerDiagnostic,
  sanitizeWorkerDiagnostic,
} from './channel-worker-diagnostics.js';

describe('channel worker diagnostics', () => {
  it('removes ANSI, control characters, and dangerous invisible characters', () => {
    expect(
      normalizeWorkerDiagnostic(
        '\u001b[31mhello\u200b\tworld\u2028!\ufe0f\u001b[0m',
      ),
    ).toBe('helloworld!');
  });

  it('redacts daemon and sensitive environment values safely', () => {
    const redact = createWorkerDiagnosticRedactor({
      daemonToken: 'daemon.+token',
      workerEnv: {
        SERVICE_TOKEN: 'token-value',
        CLIENT_SECRET: 'secret-value',
        GOOGLE_API_KEY: 'api-value',
        DATABASE_DSN: 'dsn-value',
        DATABASE_CONNECTION_STRING: 'connection-value',
        MULTILINE_PASSWORD: 'first.line\nsecond+line',
        SHORT_TOKEN: 'abc',
        PUBLIC_VALUE: 'public-value',
      },
    });

    expect(
      redact(
        'daemon.+token token-value secret-value api-value dsn-value connection-value first.line second+line abc public-value',
      ),
    ).toBe(
      '<redacted> <redacted> <redacted> <redacted> <redacted> <redacted> <redacted> <redacted> abc public-value',
    );
  });

  it('redacts before enforcing the code-point length limit', () => {
    expect(
      sanitizeWorkerDiagnostic('secret-value🙂🙂🙂', 12, {
        workerEnv: { CLIENT_SECRET: 'secret-value' },
      }),
    ).toBe('<redacted>🙂🙂');
  });
});
