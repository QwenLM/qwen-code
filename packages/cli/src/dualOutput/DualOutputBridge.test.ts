/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core';
import { DualOutputBridge } from './DualOutputBridge.js';

function createMockConfig(): Config {
  return {
    getSessionId: vi.fn().mockReturnValue('test-session'),
    getModel: vi.fn().mockReturnValue('test-model'),
  } as unknown as Config;
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('DualOutputBridge', () => {
  let tmpDir: string;
  let target: string;
  let config: Config;
  let bridge: DualOutputBridge | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-dual-output-'));
    target = path.join(tmpDir, 'events.jsonl');
    fs.writeFileSync(target, '');
    config = createMockConfig();
  });

  afterEach(async () => {
    bridge?.shutdown();
    bridge = null;
    // Give the stream a tick to flush before removing the directory
    await new Promise((r) => setTimeout(r, 10));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('--json-fd validation', () => {
    it.each([0, 1, 2])('rejects reserved fd %d', (fd) => {
      expect(() => new DualOutputBridge(config, { fd })).toThrow(/reserved/);
    });

    it('rejects an unopened fd with a clear message', () => {
      // 9999 is extremely unlikely to be open in the test process
      expect(() => new DualOutputBridge(config, { fd: 9999 })).toThrow(
        /file descriptor is not open/,
      );
    });
  });

  describe('--json-file output', () => {
    it('emits a session_start event immediately on construction', async () => {
      bridge = new DualOutputBridge(config, { filePath: target });
      bridge.shutdown();
      await new Promise((r) => setTimeout(r, 10));

      const lines = readJsonl(target);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatchObject({
        type: 'system',
        subtype: 'session_start',
        data: { session_id: 'test-session' },
      });
    });

    it('routes permission requests + responses through the adapter', async () => {
      bridge = new DualOutputBridge(config, { filePath: target });
      bridge.emitPermissionRequest('req-1', 'shell', 'tu-1', { cmd: 'ls' });
      bridge.emitControlResponse('req-1', false);
      bridge.shutdown();
      await new Promise((r) => setTimeout(r, 10));

      const lines = readJsonl(target);
      const request = lines.find((l) => l['type'] === 'control_request');
      const response = lines.find((l) => l['type'] === 'control_response');
      expect(request).toMatchObject({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'shell',
          tool_use_id: 'tu-1',
          input: { cmd: 'ls' },
          blocked_path: null,
        },
      });
      expect(response).toMatchObject({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-1',
          response: { allowed: false },
        },
      });
    });

    it('reports isConnected=false after shutdown and silently drops further events', async () => {
      bridge = new DualOutputBridge(config, { filePath: target });
      bridge.shutdown();
      expect(bridge.isConnected).toBe(false);

      // Should not throw
      expect(() =>
        bridge!.emitPermissionRequest('req', 'tool', 'tu', {}),
      ).not.toThrow();
      expect(() => bridge!.emitControlResponse('req', true)).not.toThrow();
    });
  });
});
