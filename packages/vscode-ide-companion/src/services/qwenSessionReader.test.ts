/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvBootstrapForTesting } from '../utils/paths.js';
import { QwenSessionReader } from './qwenSessionReader.js';

const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
let runtimeDir: string;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'qwen-session-reader-'));
  process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
  resetEnvBootstrapForTesting();
});

afterEach(() => {
  if (originalRuntimeDir !== undefined) {
    process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
  } else {
    delete process.env['QWEN_RUNTIME_DIR'];
  }
  resetEnvBootstrapForTesting();
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe('QwenSessionReader', () => {
  it('exposes the full-precision fractional mtimeMs alongside lastUpdated', async () => {
    // lastUpdated round-trips through an ISO string and truncates to whole
    // milliseconds; the daemon's composite session-list cursor compares
    // mtime with exact equality, so the fractional half must survive.
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const chatsDir = join(runtimeDir, 'tmp', 'project-hash', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, `${sessionId}.jsonl`);
    writeFileSync(
      filePath,
      `${JSON.stringify({
        sessionId,
        uuid: 'user-1',
        timestamp: '2026-03-22T16:48:35.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hello' }] },
      })}\n`,
    );
    const fractional = 1774200515000.467; // 2026-03-22T16:48:35.000467Z
    utimesSync(filePath, fractional / 1000, fractional / 1000);

    const reader = new QwenSessionReader();
    const summaries = await reader.getAllSessions(undefined, true);

    expect(summaries).toHaveLength(1);
    // Sub-millisecond precision survives (filesystems quantize to their own
    // granularity, so compare within a millisecond rather than exactly).
    const actual = summaries[0]?.mtimeMs ?? 0;
    expect(Math.abs(actual - fractional)).toBeLessThan(0.001);
    expect(actual % 1).not.toBe(0);
    expect(new Date(summaries[0]!.lastUpdated).getTime()).toBe(
      Math.trunc(fractional),
    );
  });

  it('projects UserPromptSubmit provenance in summaries and hydrated messages', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const chatsDir = join(runtimeDir, 'tmp', 'project-hash', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    const taggedContext =
      '<qwen:user-prompt-submit-context>\nhook-only context\n</qwen:user-prompt-submit-context>';
    writeFileSync(
      join(chatsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        sessionId,
        uuid: 'user-1',
        timestamp: '2026-03-22T16:48:35.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'expanded model prompt' }, { text: taggedContext }],
        },
        systemPayload: {
          displayText: 'raw @file prompt',
          hookContext: 'hook-only context',
        },
      })}\n`,
    );

    const reader = new QwenSessionReader();
    const summaries = await reader.getAllSessions(undefined, true);
    const hydrated = await reader.getSession(sessionId);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.firstUserText).toBe('raw @file prompt');
    expect(hydrated?.messages).toMatchObject([
      { type: 'user', content: 'raw @file prompt' },
    ]);
    expect(hydrated?.messages[0]?.content).not.toContain('hook-only context');
  });
});
