/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { validateAuthMethod, saveToQwenEnv } from './auth.js';

vi.mock('./settings.js', () => ({
  loadEnvironment: vi.fn(),
}));

describe('validateAuthMethod', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return null for LOGIN_WITH_GOOGLE', () => {
    expect(validateAuthMethod(AuthType.LOGIN_WITH_GOOGLE)).toBeNull();
  });

  it('should return null for CLOUD_SHELL', () => {
    expect(validateAuthMethod(AuthType.CLOUD_SHELL)).toBeNull();
  });

  describe('USE_GEMINI', () => {
    it('should return null if GEMINI_API_KEY is set', () => {
      process.env.GEMINI_API_KEY = 'test-key';
      expect(validateAuthMethod(AuthType.USE_GEMINI)).toBeNull();
    });

    it('should return an error message if GEMINI_API_KEY is not set', () => {
      expect(validateAuthMethod(AuthType.USE_GEMINI)).toBe(
        'GEMINI_API_KEY environment variable not found. Add that to your environment and try again (no reload needed if using .env)!',
      );
    });
  });

  describe('USE_VERTEX_AI', () => {
    it('should return null if GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are set', () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
      process.env.GOOGLE_CLOUD_LOCATION = 'test-location';
      expect(validateAuthMethod(AuthType.USE_VERTEX_AI)).toBeNull();
    });

    it('should return null if GOOGLE_API_KEY is set', () => {
      process.env.GOOGLE_API_KEY = 'test-api-key';
      expect(validateAuthMethod(AuthType.USE_VERTEX_AI)).toBeNull();
    });

    it('should return an error message if no required environment variables are set', () => {
      expect(validateAuthMethod(AuthType.USE_VERTEX_AI)).toBe(
        'When using Vertex AI, you must specify either:\n' +
          '• GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables.\n' +
          '• GOOGLE_API_KEY environment variable (if using express mode).\n' +
          'Update your environment and try again (no reload needed if using .env)!',
      );
    });
  });

  it('should return an error message for an invalid auth method', () => {
    expect(validateAuthMethod('invalid-method')).toBe(
      'Invalid auth method selected.',
    );
  });
});

describe('saveToQwenEnv', () => {
  const testDir = '/tmp/test-qwen-env-' + Date.now();
  const originalCwd = process.cwd();

  beforeEach(() => {
    // Create test directory
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    process.chdir(testDir);
  });

  afterEach(() => {
    // Clean up test files
    process.chdir(originalCwd);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create .qwen.env file with correct content', async () => {
    await saveToQwenEnv('test-api-key', 'https://api.test.com', 'test-model');

    const envPath = path.join(testDir, '.qwen.env');
    expect(fs.existsSync(envPath)).toBe(true);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('# Qwen Code API Configuration');
    expect(content).toContain('# This file is already included in .gitignore');
    expect(content).toContain('OPENAI_API_KEY=test-api-key');
    expect(content).toContain('OPENAI_BASE_URL=https://api.test.com');
    expect(content).toContain('OPENAI_MODEL=test-model');
  });

  it('should create file with secure permissions (0o600)', async () => {
    await saveToQwenEnv('test-key', 'https://api.test.com', 'model');

    const envPath = path.join(testDir, '.qwen.env');
    const stats = fs.statSync(envPath);
    const mode = stats.mode & parseInt('777', 8);
    
    // File should be readable and writable only by owner (0o600)
    expect(mode.toString(8)).toBe('600');
  });

  it('should overwrite existing file', async () => {
    const envPath = path.join(testDir, '.qwen.env');
    
    // Create initial file
    fs.writeFileSync(envPath, 'OLD_CONTENT=old');
    
    // Save new content
    await saveToQwenEnv('new-key', 'new-url', 'new-model');
    
    // Check it was overwritten
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('OLD_CONTENT');
    expect(content).toContain('OPENAI_API_KEY=new-key');
  });

  it('should handle empty values correctly', async () => {
    await saveToQwenEnv('api-key', '', '');

    const content = fs.readFileSync(path.join(testDir, '.qwen.env'), 'utf-8');
    expect(content).toContain('OPENAI_API_KEY=api-key');
    expect(content).toContain('OPENAI_BASE_URL=');
    expect(content).toContain('OPENAI_MODEL=');
  });

  it('should log success message', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await saveToQwenEnv('key', 'url', 'model');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Credentials saved securely to')
    );

    consoleSpy.mockRestore();
  });
});
