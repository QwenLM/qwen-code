/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SkillError, TrustGateError } from '@qwen-code/qwen-code-core';
import { describe, expect, it } from 'vitest';
import {
  BridgeChannelClosedError,
  BridgeTimeoutError,
  MissingCliEntryError,
  SERVE_ERROR_KINDS,
  mapDomainErrorToErrorKind,
} from './status.js';

describe('SERVE_ERROR_KINDS', () => {
  it('exposes the roadmap-defined error kinds in stable order', () => {
    // PR 13 introduced the closed taxonomy with seven preflight/env
    // kinds; PR 14 added `'budget_exhausted'` for MCP guardrail
    // refusals (see #4175 PR 14); PR 16 added `'stat_failed'` for
    // non-ENOENT stat failures on workspace memory discovery (see
    // #4175 PR 16). Issue #4514 T2.8 added three runtime-mutation
    // error kinds; T2.9 appended prompt_deadline_exceeded and
    // writer_idle_timeout. Future additions append to this list.
    expect(SERVE_ERROR_KINDS).toEqual([
      'missing_binary',
      'blocked_egress',
      'auth_env_error',
      'init_timeout',
      'protocol_error',
      'missing_file',
      'parse_error',
      'stat_failed',
      'budget_exhausted',
      'mcp_budget_would_exceed',
      'mcp_server_spawn_failed',
      'invalid_config',
      'prompt_deadline_exceeded',
      'writer_idle_timeout',
    ]);
  });

  it('exposes T2.8 error kinds in SERVE_ERROR_KINDS', () => {
    expect(SERVE_ERROR_KINDS).toContain('mcp_budget_would_exceed');
    expect(SERVE_ERROR_KINDS).toContain('mcp_server_spawn_failed');
    expect(SERVE_ERROR_KINDS).toContain('invalid_config');
  });
});

describe('BridgeTimeoutError', () => {
  it('preserves the legacy message format and exposes label/timeoutMs', () => {
    const err = new BridgeTimeoutError('init', 250);
    expect(err.name).toBe('BridgeTimeoutError');
    expect(err.message).toBe('HttpAcpBridge init timed out after 250ms');
    expect(err.label).toBe('init');
    expect(err.timeoutMs).toBe(250);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('BridgeChannelClosedError', () => {
  it('preserves the legacy "agent channel closed …" wording per context', () => {
    const sessionErr = new BridgeChannelClosedError(
      'mid-request (session abc-123)',
    );
    expect(sessionErr.name).toBe('BridgeChannelClosedError');
    expect(sessionErr.message).toBe(
      'agent channel closed mid-request (session abc-123)',
    );
    expect(sessionErr.context).toBe('mid-request (session abc-123)');
    expect(sessionErr).toBeInstanceOf(Error);

    expect(
      new BridgeChannelClosedError('mid-request (workspace status)').message,
    ).toBe('agent channel closed mid-request (workspace status)');
    expect(new BridgeChannelClosedError('during session/load').message).toBe(
      'agent channel closed during session/load',
    );
  });
});

describe('MissingCliEntryError', () => {
  it('exposes the operator-actionable remediation message verbatim', () => {
    const err = new MissingCliEntryError();
    expect(err.name).toBe('MissingCliEntryError');
    expect(err.message).toContain('Cannot determine CLI entry path');
    expect(err.message).toContain('QWEN_CLI_ENTRY');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('mapDomainErrorToErrorKind', () => {
  it('classifies BridgeTimeoutError as init_timeout', () => {
    expect(mapDomainErrorToErrorKind(new BridgeTimeoutError('init', 100))).toBe(
      'init_timeout',
    );
  });

  it('classifies SkillError(PARSE_ERROR / INVALID_CONFIG / INVALID_NAME) as parse_error', () => {
    expect(
      mapDomainErrorToErrorKind(new SkillError('bad yaml', 'PARSE_ERROR')),
    ).toBe('parse_error');
    expect(
      mapDomainErrorToErrorKind(new SkillError('bad meta', 'INVALID_CONFIG')),
    ).toBe('parse_error');
    expect(
      mapDomainErrorToErrorKind(new SkillError('bad name', 'INVALID_NAME')),
    ).toBe('parse_error');
  });

  it('classifies SkillError(FILE_ERROR / NOT_FOUND) as missing_file', () => {
    expect(
      mapDomainErrorToErrorKind(new SkillError('cannot read', 'FILE_ERROR')),
    ).toBe('missing_file');
    expect(
      mapDomainErrorToErrorKind(new SkillError('absent', 'NOT_FOUND')),
    ).toBe('missing_file');
  });

  it('classifies fs ENOENT/EACCES/EPERM as missing_file', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
      const err = Object.assign(new Error('fs op failed'), { code });
      expect(mapDomainErrorToErrorKind(err)).toBe('missing_file');
    }
  });

  it('classifies SyntaxError as parse_error', () => {
    expect(mapDomainErrorToErrorKind(new SyntaxError('bad json'))).toBe(
      'parse_error',
    );
  });

  it('classifies TrustGateError as auth_env_error (recognized via .name across package boundaries)', () => {
    const err = new TrustGateError('untrusted folder rejects YOLO');
    expect(mapDomainErrorToErrorKind(err)).toBe('auth_env_error');
    // Synthesize the same class by name alone — verifies the matcher works
    // even when a bundled-twice instance breaks `instanceof` symmetry.
    const synthetic = Object.assign(new Error('synthetic'), {
      name: 'TrustGateError',
    });
    expect(mapDomainErrorToErrorKind(synthetic)).toBe('auth_env_error');
  });

  it('classifies SkillError via .name fallback when instanceof breaks across package boundaries (#4298 follow-up)', () => {
    // Wenshao review fold-in (#4298 thread r3262781757): the same
    // cross-package bundling concern that drives the TrustGateError
    // `.name` matcher applies to `SkillError`. Synthesize a foreign
    // copy of the class (carrying the right `.name` + `.code` but
    // failing `instanceof SkillError`) and assert classification still
    // works.
    const parseSynthetic = Object.assign(new Error('foreign-bundled'), {
      name: 'SkillError',
      code: 'PARSE_ERROR',
    });
    expect(mapDomainErrorToErrorKind(parseSynthetic)).toBe('parse_error');

    const fileSynthetic = Object.assign(new Error('foreign-bundled'), {
      name: 'SkillError',
      code: 'FILE_ERROR',
    });
    expect(mapDomainErrorToErrorKind(fileSynthetic)).toBe('missing_file');

    // Unknown skill code on a cross-bundle SkillError still degrades
    // to undefined rather than a misleading category — same behavior
    // as the genuine `instanceof` path.
    const unknownSynthetic = Object.assign(new Error('foreign-bundled'), {
      name: 'SkillError',
      code: 'NOT_A_REAL_CODE',
    });
    expect(mapDomainErrorToErrorKind(unknownSynthetic)).toBeUndefined();
  });

  it('classifies ModelConfigError subclasses (recognized via .name) as auth_env_error', () => {
    for (const name of [
      'StrictMissingCredentialsError',
      'StrictMissingModelIdError',
      'MissingApiKeyError',
      'MissingModelError',
      'MissingBaseUrlError',
      'MissingAnthropicBaseUrlEnvError',
    ]) {
      const err = new Error(`fake ${name} payload`);
      err.name = name;
      expect(mapDomainErrorToErrorKind(err)).toBe('auth_env_error');
    }
  });

  it('classifies BridgeChannelClosedError as protocol_error', () => {
    expect(
      mapDomainErrorToErrorKind(
        new BridgeChannelClosedError('mid-request (session abc)'),
      ),
    ).toBe('protocol_error');
    expect(
      mapDomainErrorToErrorKind(
        new BridgeChannelClosedError('mid-request (workspace status)'),
      ),
    ).toBe('protocol_error');
    expect(
      mapDomainErrorToErrorKind(
        new BridgeChannelClosedError('during session/load'),
      ),
    ).toBe('protocol_error');
  });

  it('classifies MissingCliEntryError as missing_binary', () => {
    expect(mapDomainErrorToErrorKind(new MissingCliEntryError())).toBe(
      'missing_binary',
    );
  });

  it('does NOT classify foreign errors that merely contain bridge phrases', () => {
    // Regression for #4299: the previous regex-based fallback would
    // misclassify any unrelated `Error` whose `.message` happened to
    // contain "agent channel closed" or "Cannot determine CLI entry
    // path" (e.g. a wrapping error or a user-authored message in an
    // unrelated module). Typed-error recognition closes that hole.
    expect(
      mapDomainErrorToErrorKind(
        new Error('wrapped: agent channel closed mid-request'),
      ),
    ).toBe(undefined);
    expect(
      mapDomainErrorToErrorKind(
        new Error('Cannot determine CLI entry path for some other reason'),
      ),
    ).toBe(undefined);
  });

  it('returns undefined for unrelated or non-Error values', () => {
    expect(mapDomainErrorToErrorKind(new Error('something else'))).toBe(
      undefined,
    );
    expect(mapDomainErrorToErrorKind('plain string')).toBe(undefined);
    expect(mapDomainErrorToErrorKind(null)).toBe(undefined);
    expect(mapDomainErrorToErrorKind(undefined)).toBe(undefined);
    expect(mapDomainErrorToErrorKind({ code: 'ENOTFOUND' })).toBe(undefined);
  });
});
