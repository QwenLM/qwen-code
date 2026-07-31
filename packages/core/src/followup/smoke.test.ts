/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Smoke Tests — E2E verification of core followup modules working together.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldFilterSuggestion,
  getFilterReason,
} from './suggestionGenerator.js';
import { OverlayFs } from './overlayFs.js';
import { evaluateToolCall, rewritePathArgs } from './speculationToolGate.js';
import {
  saveCacheSafeParams,
  getCacheSafeParams,
  clearCacheSafeParams,
} from '../utils/forkedAgent.js';
import { ensureToolResultPairing } from './speculation.js';
import { ToolNames } from '../tools/tool-names.js';
import { ApprovalMode } from '../config/config.js';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('SMOKE TESTS — E2E Verification', () => {
  describe('Smoke 1: Filter against realistic LLM outputs', () => {
    const good = [
      'commit this',
      'run the tests',
      'try it out',
      'push it',
      'yes',
      '/commit',
      'create a PR',
      'run nicely formatted tests',
      'fix the greatest issue',
    ];
    const bad = [
      'done',
      'looks good',
      'Let me check that',
      'nothing found',
      '(silence)',
      'thanks for the help',
      "I'll run the tests",
    ];

    it.each(good)('allows: "%s"', (s) => {
      expect(shouldFilterSuggestion(s)).toBe(false);
    });

    it.each(bad)('filters: "%s"', (s) => {
      expect(shouldFilterSuggestion(s)).toBe(true);
    });

    it('getFilterReason returns named reasons', () => {
      expect(getFilterReason('done')).toBe('done');
      expect(getFilterReason('nothing found')).toBe('meta_text');
      expect(getFilterReason('(no suggestion needed)')).toBe('meta_wrapped');
      expect(getFilterReason('commit this')).toBeNull();
    });
  });

  describe('Smoke 2: OverlayFs full round-trip', () => {
    it('write → read overlay → apply → verify real file', async () => {
      const dir = join(tmpdir(), `smoke-${randomUUID().slice(0, 8)}`);
      await mkdir(dir, { recursive: true });
      const realFile = join(dir, 'app.ts');
      await writeFile(realFile, 'original content');

      const overlay = new OverlayFs(dir);

      const overlayPath = await overlay.redirectWrite(realFile);
      await writeFile(overlayPath, 'modified in speculation');

      expect(overlay.resolveReadPath(realFile)).toBe(overlayPath);
      expect(await readFile(realFile, 'utf-8')).toBe('original content');

      const applied = await overlay.applyToReal();
      expect(applied).toContain(realFile);
      expect(await readFile(realFile, 'utf-8')).toBe('modified in speculation');

      await overlay.cleanup();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('Smoke 3: ToolGate → OverlayFs integration', () => {
    it('write redirects to overlay, read resolves from overlay', async () => {
      const dir = join(tmpdir(), `smoke-gate-${randomUUID().slice(0, 8)}`);
      await mkdir(dir, { recursive: true });
      const overlay = new OverlayFs(dir);
      const filePath = join(dir, 'file.ts');
      await writeFile(filePath, 'real content');

      const wr = await evaluateToolCall(
        ToolNames.EDIT,
        { file_path: filePath },
        overlay,
        ApprovalMode.AUTO_EDIT,
      );
      expect(wr.action).toBe('redirect');

      const writeArgs: Record<string, unknown> = { file_path: filePath };
      await rewritePathArgs(writeArgs, overlay);
      const op = writeArgs['file_path'] as string;
      expect(op).toContain('qwen-speculation');
      await writeFile(op, 'speculated content');

      const readArgs: Record<string, unknown> = { file_path: filePath };
      await evaluateToolCall(
        ToolNames.READ_FILE,
        readArgs,
        overlay,
        ApprovalMode.AUTO_EDIT,
      );
      expect(readArgs['file_path']).toBe(op);
      expect(await readFile(filePath, 'utf-8')).toBe('real content');

      await overlay.cleanup();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('Smoke 4: CacheSafeParams lifecycle', () => {
    it('save → get → mutate → verify isolation → clear', () => {
      clearCacheSafeParams();

      const config = {
        systemInstruction: 'You are helpful',
        tools: [{ functionDeclarations: [{ name: 'edit' }] }],
      };

      saveCacheSafeParams(
        config,
        [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
        'qwen-max',
      );

      const p = getCacheSafeParams();
      expect(p).not.toBeNull();
      expect(p!.model).toBe('qwen-max');

      (
        config.tools[0] as { functionDeclarations: unknown[] }
      ).functionDeclarations.push({ name: 'shell' });
      const saved = getCacheSafeParams();
      const tools = saved!.generationConfig.tools as Array<{
        functionDeclarations: unknown[];
      }>;
      expect(tools[0].functionDeclarations).toHaveLength(1);

      clearCacheSafeParams();
      expect(getCacheSafeParams()).toBeNull();
    });
  });

  describe('Smoke 5: ensureToolResultPairing', () => {
    it('strips orphaned functionCalls, keeps text', () => {
      const messages = [
        { role: 'user' as const, parts: [{ text: 'edit file' }] },
        {
          role: 'model' as const,
          parts: [
            { text: 'editing...' },
            { functionCall: { name: 'edit', args: {} } },
            { functionCall: { name: 'shell', args: {} } },
          ],
        },
      ];

      const result = ensureToolResultPairing(messages);
      expect(result).toHaveLength(2);
      expect(result[1].parts).toEqual([{ text: 'editing...' }]);
    });
  });
});
