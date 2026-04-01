/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { rememberCommand } from './rememberCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('rememberCommand', () => {
  it('returns usage error when no args are provided', () => {
    const result = rememberCommand.action?.(createMockCommandContext(), '   ');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /remember [--global|--project] <text to remember>',
    });
  });

  it('creates a save_memory tool action without scope by default', () => {
    const result = rememberCommand.action?.(
      createMockCommandContext(),
      'Remember this fact',
    );
    expect(result).toEqual({
      type: 'tool',
      toolName: 'save_memory',
      toolArgs: { fact: 'Remember this fact' },
    });
  });

  it('creates a project-scoped save_memory tool action', () => {
    const result = rememberCommand.action?.(
      createMockCommandContext(),
      '--project Project-specific fact',
    );
    expect(result).toEqual({
      type: 'tool',
      toolName: 'save_memory',
      toolArgs: { fact: 'Project-specific fact', scope: 'project' },
    });
  });
});