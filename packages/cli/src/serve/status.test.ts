/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SkillError } from '@qwen-code/qwen-code-core';
import { describe, expect, it } from 'vitest';
import {
  BridgeTimeoutError,
  SERVE_ERROR_KINDS,
  mapDomainErrorToErrorKind,
} from './status.js';

describe('SERVE_ERROR_KINDS', () => {
  it('exposes the roadmap-defined error kinds in stable order', () => {
    // PR 13 introduced the closed taxonomy with seven preflight/env
    // kinds; PR 14 added `'budget_exhausted'` for MCP guardrail
    // refusals (see #4175 PR 14); PR 16 added `'stat_failed'` for
    // non-ENOENT stat failures on workspace memory discovery (see
    // #4175 PR 16). Future additions append to this list — the
    // order is part of the contract so SDK consumers can pattern-
    // match without per-kind lookups.
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
    ]);
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

  it('classifies agent-channel-closed message as protocol_error', () => {
    expect(
      mapDomainErrorToErrorKind(new Error('agent channel closed mid-request')),
    ).toBe('protocol_error');
  });

  it('classifies "Cannot determine CLI entry path" message as missing_binary', () => {
    expect(
      mapDomainErrorToErrorKind(new Error('Cannot determine CLI entry path')),
    ).toBe('missing_binary');
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
