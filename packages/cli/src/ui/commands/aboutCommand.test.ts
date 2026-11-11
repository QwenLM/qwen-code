/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type React from 'react';
import { aboutCommand } from './aboutCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { getVersion } from '@qwen-code/core';
import { CLI_TAGLINE } from '../../brand.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    getVersion: vi.fn(),
  };
});

describe('aboutCommand', () => {
  let mockContext: CommandContext;
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getModel: vi.fn(),
          },
        },
        settings: {
          merged: {
            security: {
              auth: {
                selectedType: 'test-auth',
              },
            },
          },
        },
      },
      ui: {
        addItem: vi.fn(),
      },
    } as unknown as CommandContext);

    vi.mocked(getVersion).mockResolvedValue('test-version');
    vi.spyOn(
      mockContext.services.agentContext!.config,
      'getModel',
    ).mockReturnValue('test-model');
    Object.defineProperty(process, 'platform', {
      value: 'test-os',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  /**
   * Runs the command and returns the props handed to the AboutBox dialog.
   */
  async function runAndGetAboutProps(): Promise<Record<string, unknown>> {
    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }
    const result = await aboutCommand.action(mockContext, '');
    if (!result || result.type !== 'custom_dialog') {
      throw new Error(`Expected a custom_dialog result, got ${result?.type}`);
    }
    return (result.component as React.ReactElement).props as Record<
      string,
      unknown
    >;
  }

  it('should have the correct name and description', () => {
    expect(aboutCommand.name).toBe('about');
    expect(aboutCommand.description).toBe('Show version info');
  });

  it('renders only generic version information', async () => {
    const props = await runAndGetAboutProps();

    expect(props).toMatchObject({
      cliVersion: 'test-version',
      osVersion: 'test-os',
      modelVersion: 'test-model',
      tagline: CLI_TAGLINE,
    });
    expect(props).not.toHaveProperty('authMethod');
    expect(props).not.toHaveProperty('tier');
  });
});
