/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PROJECT_ENV_HARDCODED_EXCLUSIONS } from './shared-env-keys.js';

describe('PROJECT_ENV_HARDCODED_EXCLUSIONS', () => {
  // Security guard: a project `.env` must never be able to disable TLS
  // certificate verification. Removing this key would let an untrusted repo
  // silently turn off MITM protection for all API connections.
  it('excludes QWEN_TLS_INSECURE so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_TLS_INSECURE');
  });

  // isTlsVerificationDisabled() also honors NODE_TLS_REJECT_UNAUTHORIZED=0, and
  // the initial .env load only consults this list, so it must be blocked here
  // too — otherwise a project .env could bypass TLS via the Node-native var.
  it('excludes NODE_TLS_REJECT_UNAUTHORIZED so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });
});
