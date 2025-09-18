/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SubagentError, SubagentErrorCode } from './types.js';

describe('SubagentError', () => {
  it('should create error with message and code', () => {
    const error = new SubagentError('Test error', SubagentErrorCode.NOT_FOUND);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SubagentError');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe(SubagentErrorCode.NOT_FOUND);
    expect(error.subagentName).toBeUndefined();
  });

  it('should create error with subagent name', () => {
    const error = new SubagentError(
      'Test error',
      SubagentErrorCode.INVALID_CONFIG,
      'test-agent',
    );

    expect(error.subagentName).toBe('test-agent');
  });

  it('should have correct error codes', () => {
    expect(SubagentErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(SubagentErrorCode.ALREADY_EXISTS).toBe('ALREADY_EXISTS');
    expect(SubagentErrorCode.INVALID_CONFIG).toBe('INVALID_CONFIG');
    expect(SubagentErrorCode.INVALID_NAME).toBe('INVALID_NAME');
    expect(SubagentErrorCode.FILE_ERROR).toBe('FILE_ERROR');
    expect(SubagentErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(SubagentErrorCode.TOOL_NOT_FOUND).toBe('TOOL_NOT_FOUND');
  });
});
