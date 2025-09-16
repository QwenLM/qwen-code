/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initCommand } from './initCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { type CommandContext } from './types.js';

// Mock the 'fs' module with both named and default exports to avoid breaking default import sites
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = vi.fn();
  const writeFileSync = vi.fn();
  const readFileSync = vi.fn();
  return {
    ...actual,
    existsSync,
    writeFileSync,
    readFileSync,
    default: {
      ...(actual as unknown as Record<string, unknown>),
      existsSync,
      writeFileSync,
      readFileSync,
    },
  } as unknown as typeof import('fs');
});

describe('initCommand', () => {
  let mockContext: CommandContext;
  const targetDir = '/test/dir';
  const DEFAULT_CONTEXT_FILENAME = 'QWEN.md';
  const geminiMdPath = path.join(targetDir, DEFAULT_CONTEXT_FILENAME);

  beforeEach(() => {
    // Create a fresh mock context for each test
    mockContext = createMockCommandContext({
      services: {
        config: {
          getTargetDir: () => targetDir,
        },
      },
    });
  });

  afterEach(() => {
    // Clear all mocks after each test
    vi.clearAllMocks();
  });

  it(`should ask for confirmation if ${DEFAULT_CONTEXT_FILENAME} already exists and is non-empty`, async () => {
    // Arrange: Simulate that the file exists
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('# Existing content');

    // Act: Run the command's action
    const result = await initCommand.action!(mockContext, '');

    // Assert: Check for the correct confirmation request
    expect(result).toEqual(
      expect.objectContaining({
        type: 'confirm_action',
        prompt: expect.anything(), // React element, not a string
        originalInvocation: expect.anything(),
      }),
    );
    // Assert: Ensure no file was written yet
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it(`should create ${DEFAULT_CONTEXT_FILENAME} and submit a prompt if it does not exist`, async () => {
    // Arrange: Simulate that the file does not exist
    vi.mocked(fs.existsSync).mockReturnValue(false);

    // Act: Run the command's action
    const result = await initCommand.action!(mockContext, '');

    // Assert: Check that writeFileSync was called correctly
    expect(fs.writeFileSync).toHaveBeenCalledWith(geminiMdPath, '', 'utf8');

    // Assert: Check that an informational message was added to the UI
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: `Empty ${DEFAULT_CONTEXT_FILENAME} created. Now analyzing the project to populate it.`,
      },
      expect.any(Number),
    );

    // Assert: Check that the correct prompt is submitted
    expect(result).toEqual(
      expect.objectContaining({
        type: 'submit_prompt',
        content: expect.stringContaining(
          'You are Qwen Code, an interactive CLI agent',
        ),
      }),
    );
  });

  it(`should proceed to initialize when ${DEFAULT_CONTEXT_FILENAME} exists but is empty`, async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('   \n  ');

    const result = await initCommand.action!(mockContext, '');

    expect(fs.writeFileSync).toHaveBeenCalledWith(geminiMdPath, '', 'utf8');
    expect(result).toEqual(
      expect.objectContaining({
        type: 'submit_prompt',
      }),
    );
  });

  it(`should regenerate ${DEFAULT_CONTEXT_FILENAME} when overwrite is confirmed`, async () => {
    // Arrange: Simulate that the file exists and overwrite is confirmed
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('# Existing content');
    mockContext.overwriteConfirmed = true;

    // Act: Run the command's action
    const result = await initCommand.action!(mockContext, '');

    // Assert: Check that writeFileSync was called correctly
    expect(fs.writeFileSync).toHaveBeenCalledWith(geminiMdPath, '', 'utf8');

    // Assert: Check that an informational message was added to the UI
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: `Empty ${DEFAULT_CONTEXT_FILENAME} created. Now analyzing the project to populate it.`,
      },
      expect.any(Number),
    );

    // Assert: Check that the correct prompt is submitted
    expect(result).toEqual(
      expect.objectContaining({
        type: 'submit_prompt',
        content: expect.stringContaining(
          'You are Qwen Code, an interactive CLI agent',
        ),
      }),
    );
  });

  it('should return an error if config is not available', async () => {
    // Arrange: Create a context without config
    const noConfigContext = createMockCommandContext();
    if (noConfigContext.services) {
      noConfigContext.services.config = null;
    }

    // Act: Run the command's action
    const result = await initCommand.action!(noConfigContext, '');

    // Assert: Check for the correct error message
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    });
  });
});
