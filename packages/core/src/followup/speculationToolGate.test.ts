/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evaluateToolCall, rewritePathArgs } from './speculationToolGate.js';
import { OverlayFs } from './overlayFs.js';
import { ToolNames } from '../tools/tool-names.js';
import { ApprovalMode } from '../config/config.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('speculationToolGate', () => {
  let testDir: string;
  let overlayFs: OverlayFs;

  beforeEach(async () => {
    testDir = join(tmpdir(), `gate-test-${randomUUID().slice(0, 8)}`);
    await mkdir(testDir, { recursive: true });
    overlayFs = new OverlayFs(testDir);
  });

  afterEach(async () => {
    await overlayFs.cleanup();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('SAFE_READ_ONLY_TOOLS', () => {
    it.each([
      ToolNames.READ_FILE,
      ToolNames.GREP,
      ToolNames.GLOB,
      ToolNames.LS,
      ToolNames.LSP,
    ])('allows %s', async (toolName) => {
      const result = await evaluateToolCall(
        toolName,
        {},
        overlayFs,
        ApprovalMode.DEFAULT,
      );
      expect(result.action).toBe('allow');
    });
  });

  describe('WRITE_TOOLS', () => {
    it('redirects edit in auto-edit mode', async () => {
      const result = await evaluateToolCall(
        ToolNames.EDIT,
        {},
        overlayFs,
        ApprovalMode.AUTO_EDIT,
      );
      expect(result.action).toBe('redirect');
    });

    it('redirects write_file in yolo mode', async () => {
      const result = await evaluateToolCall(
        ToolNames.WRITE_FILE,
        {},
        overlayFs,
        ApprovalMode.YOLO,
      );
      expect(result.action).toBe('redirect');
    });

    it('hits boundary for edit in default mode', async () => {
      const result = await evaluateToolCall(
        ToolNames.EDIT,
        {},
        overlayFs,
        ApprovalMode.DEFAULT,
      );
      expect(result.action).toBe('boundary');
    });

    it('hits boundary for write_file in plan mode', async () => {
      const result = await evaluateToolCall(
        ToolNames.WRITE_FILE,
        {},
        overlayFs,
        ApprovalMode.PLAN,
      );
      expect(result.action).toBe('boundary');
    });
  });

  describe('SHELL', () => {
    it('allows read-only shell commands', async () => {
      const result = await evaluateToolCall(
        ToolNames.SHELL,
        { command: 'ls -la' },
        overlayFs,
        ApprovalMode.DEFAULT,
      );
      expect(result.action).toBe('allow');
    });

    it('hits boundary for non-read-only shell commands', async () => {
      const result = await evaluateToolCall(
        ToolNames.SHELL,
        { command: 'rm -rf /' },
        overlayFs,
        ApprovalMode.DEFAULT,
      );
      expect(result.action).toBe('boundary');
    });

    it('hits boundary for empty command', async () => {
      const result = await evaluateToolCall(
        ToolNames.SHELL,
        { command: '' },
        overlayFs,
        ApprovalMode.DEFAULT,
      );
      expect(result.action).toBe('boundary');
    });
  });

  describe('BOUNDARY_TOOLS', () => {
    it.each([
      ToolNames.AGENT,
      ToolNames.SKILL,
      ToolNames.TODO_WRITE,
      ToolNames.MEMORY,
      ToolNames.ASK_USER_QUESTION,
      ToolNames.EXIT_PLAN_MODE,
      ToolNames.WEB_FETCH,
      ToolNames.WEB_SEARCH,
    ])('hits boundary for %s', async (toolName) => {
      const result = await evaluateToolCall(
        toolName,
        {},
        overlayFs,
        ApprovalMode.DEFAULT,
      );
      expect(result.action).toBe('boundary');
    });
  });

  describe('unknown tools', () => {
    it('hits boundary for unknown tool names', async () => {
      const result = await evaluateToolCall(
        'mcp_custom_tool',
        {},
        overlayFs,
        ApprovalMode.DEFAULT,
      );
      expect(result.action).toBe('boundary');
      expect(result.reason).toContain('unknown_tool');
    });
  });

  describe('rewritePathArgs', () => {
    it('rewrites file_path argument', async () => {
      const filePath = join(testDir, 'src', 'app.ts');
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(filePath, 'content');

      const args: Record<string, unknown> = { file_path: filePath };
      await rewritePathArgs(args, overlayFs);

      expect(args['file_path']).not.toBe(filePath);
      expect(String(args['file_path'])).toContain('qwen-speculation');
    });

    it('rewrites filePath argument (camelCase)', async () => {
      const filePath = join(testDir, 'file.ts');
      await writeFile(filePath, 'content');

      const args: Record<string, unknown> = { filePath };
      await rewritePathArgs(args, overlayFs);

      expect(args['filePath']).not.toBe(filePath);
    });

    it('does nothing when no path arguments present', async () => {
      const args: Record<string, unknown> = { command: 'ls' };
      await rewritePathArgs(args, overlayFs);

      expect(args['command']).toBe('ls');
    });
  });
});
