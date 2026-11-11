/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it } from 'vitest';
import { performInit } from './init.js';
import type { SubmitPromptActionReturn } from './types.js';
import { CONFIG_DIR } from '../utils/paths.js';

function getPromptContent(result: { type: string }): string {
  expect(result.type).toBe('submit_prompt');

  return (result as SubmitPromptActionReturn).content as string;
}

describe('performInit', () => {
  describe('quick mode (default)', () => {
    it('returns submit_prompt with quick analysis prompt', () => {
      const content = getPromptContent(
        performInit({ contextFileName: 'AGENTS.md' }),
      );
      expect(content).toContain('Analyze the codebase');
      expect(content).toContain('AGENTS.md');
    });

    it('does not include multi-phase workflow', () => {
      const content = getPromptContent(
        performInit({ contextFileName: 'AGENTS.md' }),
      );
      expect(content).not.toContain('## Phase');
      expect(content).not.toContain('AskUserQuestion');
    });

    it('uses custom contextFileName', () => {
      const content = getPromptContent(
        performInit({ mode: 'quick', contextFileName: 'CUSTOM.md' }),
      );
      expect(content).toContain('CUSTOM.md');
    });
  });

  describe('interactive mode', () => {
    it('returns submit_prompt with multi-phase prompt', () => {
      const content = getPromptContent(
        performInit({ mode: 'interactive', contextFileName: 'AGENTS.md' }),
      );
      expect(content).toContain('Phase 1');
      expect(content).toContain('AskUserQuestion');
    });

    it('uses correct context file name and config dir in prompt', () => {
      const content = getPromptContent(
        performInit({
          mode: 'interactive',
          contextFileName: 'CUSTOM.md',
          configDir: '.my-config',
        }),
      );
      expect(content).toContain('CUSTOM.md');
      expect(content).toContain('.my-config');
      expect(content).toContain('.my-config/skills/');
      expect(content).toContain('.my-config/settings.json');
    });

    it('includes hook schema in prompt', () => {
      const content = getPromptContent(
        performInit({ mode: 'interactive', contextFileName: 'AGENTS.md' }),
      );
      expect(content).toContain('PreToolUse');
      expect(content).toContain('PostToolUse');
      expect(content).toContain('settings.json');
    });

    it('defaults configDir to CONFIG_DIR', () => {
      const content = getPromptContent(
        performInit({ mode: 'interactive', contextFileName: 'AGENTS.md' }),
      );
      expect(content).toContain(`${CONFIG_DIR}/skills/`);
      expect(content).toContain(`${CONFIG_DIR}/settings.json`);
    });

    it('includes all 7 phases', () => {
      const content = getPromptContent(
        performInit({ mode: 'interactive', contextFileName: 'AGENTS.md' }),
      );
      for (let i = 1; i <= 7; i++) {
        expect(content).toContain(`## Phase ${i}`);
      }
    });
  });
});
