/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@agentclientprotocol/sdk';

// AcpConnection imports AcpFileHandler which imports vscode.
// Mock vscode so it can be resolved without the actual VS Code runtime.
vi.mock('vscode', () => ({}));

import { AcpConnection } from './acpConnection.js';
import { ACP_ERROR_CODES } from '../constants/acpSchema.js';

describe('AcpConnection readTextFile error mapping', () => {
  it('maps ENOENT to RESOURCE_NOT_FOUND RequestError', () => {
    const conn = new AcpConnection() as unknown as {
      mapReadTextFileError: (error: unknown, filePath: string) => unknown;
    };
    const enoent = Object.assign(new Error('missing file'), { code: 'ENOENT' });

    expect(() =>
      conn.mapReadTextFileError(enoent, '/tmp/missing.txt'),
    ).toThrowError(
      expect.objectContaining({
        code: ACP_ERROR_CODES.RESOURCE_NOT_FOUND,
      }),
    );
  });

  it('keeps non-ENOENT RequestError unchanged', () => {
    const conn = new AcpConnection() as unknown as {
      mapReadTextFileError: (error: unknown, filePath: string) => unknown;
    };
    const requestError = new RequestError(
      ACP_ERROR_CODES.INTERNAL_ERROR,
      'Internal error',
    );

    expect(conn.mapReadTextFileError(requestError, '/tmp/file.txt')).toBe(
      requestError,
    );
  });

  it('passes structured ACP prompt blocks through without wrapping them as text', async () => {
    const prompt = vi.fn().mockResolvedValue({});
    const onEndTurn = vi.fn();
    const conn = new AcpConnection() as unknown as {
      sdkConnection: {
        prompt: (params: {
          sessionId: string;
          prompt: ContentBlock[];
        }) => Promise<unknown>;
      };
      sessionId: string | null;
      onEndTurn: (reason?: string) => void;
      sendPrompt: (prompt: string | ContentBlock[]) => Promise<unknown>;
    };
    const promptBlocks: ContentBlock[] = [
      { type: 'text', text: 'Inspect this image' },
      {
        type: 'resource_link',
        name: 'pasted image.png',
        mimeType: 'image/png',
        uri: 'file:///tmp/pasted image.png',
      },
    ];

    conn.sdkConnection = { prompt };
    conn.sessionId = 'session-1';
    conn.onEndTurn = onEndTurn;

    await conn.sendPrompt(promptBlocks);

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: promptBlocks,
    });
    expect(onEndTurn).toHaveBeenCalled();
  });
});
