/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { GeminiEventType } from '@qwen-code/qwen-code-core';
import { StreamJsonOutputAdapter } from './StreamJsonOutputAdapter.js';

/**
 * Tests covering the dual-output extensions to StreamJsonOutputAdapter:
 *   - injected outputStream (used by DualOutputBridge to redirect output
 *     to fd / file instead of stdout);
 *   - emitPermissionRequest / emitControlResponse, which carry tool
 *     approval events over the same channel.
 *
 * Kept in a separate file from StreamJsonOutputAdapter.test.ts so new
 * assertions do not force a relint of the pre-existing file.
 */

function createMockConfig(): Config {
  return {
    getSessionId: vi.fn().mockReturnValue('test-session-id'),
    getModel: vi.fn().mockReturnValue('test-model'),
  } as unknown as Config;
}

describe('StreamJsonOutputAdapter — dual-output extensions', () => {
  let mockConfig: Config;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutWriteSpy: any;

  beforeEach(() => {
    mockConfig = createMockConfig();
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  describe('custom outputStream injection', () => {
    it('writes to the injected stream instead of stdout', () => {
      const writes: string[] = [];
      const customStream = {
        write(chunk: string): boolean {
          writes.push(chunk);
          return true;
        },
      } as unknown as NodeJS.WritableStream;

      const adapter = new StreamJsonOutputAdapter(
        mockConfig,
        false,
        customStream,
      );
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'sidecar',
      });
      adapter.finalizeAssistantMessage();

      expect(writes.length).toBeGreaterThan(0);
      expect(stdoutWriteSpy).not.toHaveBeenCalled();

      const lastParsed = JSON.parse(writes[writes.length - 1]);
      expect(lastParsed.type).toBe('assistant');
    });
  });

  describe('emitPermissionRequest / emitControlResponse', () => {
    it('emits a control_request with subtype can_use_tool', () => {
      const adapter = new StreamJsonOutputAdapter(mockConfig, false);
      stdoutWriteSpy.mockClear();

      adapter.emitPermissionRequest(
        'req-1',
        'run_shell_command',
        'tool-use-1',
        { command: 'ls' },
        '/etc/passwd',
      );

      expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(stdoutWriteSpy.mock.calls[0][0] as string);
      expect(parsed).toEqual({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'run_shell_command',
          tool_use_id: 'tool-use-1',
          input: { command: 'ls' },
          permission_suggestions: null,
          blocked_path: '/etc/passwd',
        },
      });
    });

    it('emits a control_response with the supplied request_id and allowed flag', () => {
      const adapter = new StreamJsonOutputAdapter(mockConfig, false);
      stdoutWriteSpy.mockClear();

      adapter.emitControlResponse('req-1', true);

      expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(stdoutWriteSpy.mock.calls[0][0] as string);
      expect(parsed).toEqual({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-1',
          response: { allowed: true },
        },
      });
    });

    it('defaults blocked_path to null when omitted', () => {
      const adapter = new StreamJsonOutputAdapter(mockConfig, false);
      stdoutWriteSpy.mockClear();

      adapter.emitPermissionRequest('req-2', 'read_file', 'tool-use-2', {
        path: 'README.md',
      });

      const parsed = JSON.parse(stdoutWriteSpy.mock.calls[0][0] as string);
      expect(parsed.request.blocked_path).toBeNull();
    });
  });
});
