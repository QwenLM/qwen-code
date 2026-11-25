/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import * as fs from 'node:fs';
import os from 'node:os';
import type { Config } from '../config/config.js';
import {
  autoNameSessionFromPlan,
  validatePlanContent,
  validatePlanPath,
} from './planUtils.js';
import { TranscriptRepository } from '../services/transcript/repository.js';

describe('planUtils', () => {
  let tempRootDir: string;
  let plansDir: string;

  beforeEach(() => {
    tempRootDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'planUtils-test-')),
    );
    const plansDirRaw = path.join(tempRootDir, 'plans');
    fs.mkdirSync(plansDirRaw, { recursive: true });
    plansDir = fs.realpathSync(plansDirRaw);
  });

  afterEach(() => {
    if (fs.existsSync(tempRootDir)) {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
  });

  describe('validatePlanPath', () => {
    it('should return null for a valid path within plans directory', async () => {
      const planPath = path.join('plans', 'test.md');
      const fullPath = path.join(tempRootDir, planPath);
      fs.writeFileSync(fullPath, '# My Plan');

      const result = await validatePlanPath(planPath, plansDir);
      expect(result).toBeNull();
    });

    it('should return error for non-existent file', async () => {
      const planPath = path.join('plans', 'ghost.md');
      const result = await validatePlanPath(planPath, plansDir);
      expect(result).toContain('Plan file does not exist');
    });

    it('should detect path traversal via symbolic links', async () => {
      const maliciousPath = path.join('plans', 'malicious.md');
      const fullMaliciousPath = path.join(tempRootDir, maliciousPath);
      const outsideFile = path.join(tempRootDir, 'outside.txt');
      fs.writeFileSync(outsideFile, 'secret content');

      fs.symlinkSync(outsideFile, fullMaliciousPath);

      const result = await validatePlanPath(maliciousPath, plansDir);
      expect(result).toContain('Access denied');
    });
  });

  describe('validatePlanContent', () => {
    it('should return null for non-empty content', async () => {
      const planPath = path.join(plansDir, 'full.md');
      fs.writeFileSync(planPath, 'some content');
      const result = await validatePlanContent(planPath);
      expect(result).toBeNull();
    });

    it('should return error for empty content', async () => {
      const planPath = path.join(plansDir, 'empty.md');
      fs.writeFileSync(planPath, '   ');
      const result = await validatePlanContent(planPath);
      expect(result).toContain('Plan file is empty');
    });

    it('should return error for unreadable file', async () => {
      const planPath = path.join(plansDir, 'ghost.md');
      const result = await validatePlanContent(planPath);
      expect(result).toContain('Plan file is empty');
    });
  });

  describe('autoNameSessionFromPlan', () => {
    const sessionId = 'session-1';

    function writeTranscript(lines: Array<Record<string, unknown>>): string {
      const filePath = path.join(tempRootDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        filePath,
        lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      );
      return filePath;
    }

    function customTitle(title: string): Record<string, unknown> {
      return { type: 'custom-title', sessionId, customTitle: title };
    }

    function createConfig(
      transcriptPath: string,
      options: { onInference?: () => void } = {},
    ) {
      const persistSessionTitle = vi.fn().mockResolvedValue(undefined);
      const setTopic = vi.fn();
      const inference = vi.fn().mockImplementation(async () => {
        options.onInference?.();
        return {
          completed: Promise.resolve({
            blocks: [{ type: 'text', text: 'Refactor auth pipeline' }],
          }),
        };
      });
      const repository = new TranscriptRepository();
      const config = {
        getSessionId: () => sessionId,
        getActiveSessionTranscriptPath: () => transcriptPath,
        getTranscriptStore: () => ({ repository: () => repository }),
        getModelProviderManager: () => ({
          select: async () => ({
            model: { key: 'lite', source: 'qwen-provider', limits: {} },
            config: {},
          }),
          inference,
        }),
        topicState: {
          setTopic,
        },
        persistSessionTitle,
      } as unknown as Config;
      return { config, inference, persistSessionTitle, setTopic };
    }

    it('persists the generated name and updates the active topic', async () => {
      const { config, inference, persistSessionTitle, setTopic } =
        createConfig(path.join(tempRootDir, 'missing.jsonl'));

      await autoNameSessionFromPlan(
        'Implement the approved auth refactor.',
        config,
      );

      expect(inference).toHaveBeenCalledTimes(1);
      expect(setTopic).toHaveBeenCalledWith(
        'Refactor auth pipeline',
        undefined,
      );
      expect(persistSessionTitle).toHaveBeenCalledWith(
        'Refactor auth pipeline',
      );
    });

    it('names a persisted session that has only an ai-title', async () => {
      const transcriptPath = writeTranscript([
        { type: 'ai-title', sessionId, aiTitle: 'Review design' },
      ]);
      const { config, persistSessionTitle } = createConfig(transcriptPath);

      await autoNameSessionFromPlan('Implement the plan.', config);

      expect(persistSessionTitle).toHaveBeenCalledWith(
        'Refactor auth pipeline',
      );
    });

    it('keeps a custom title set by /rename and skips generation', async () => {
      const transcriptPath = writeTranscript([customTitle('wests')]);
      const { config, inference, persistSessionTitle, setTopic } =
        createConfig(transcriptPath);

      await autoNameSessionFromPlan('Implement the plan.', config);

      expect(inference).not.toHaveBeenCalled();
      expect(setTopic).not.toHaveBeenCalled();
      expect(persistSessionTitle).not.toHaveBeenCalled();
    });

    it('uses the latest custom title record of the session', async () => {
      const transcriptPath = writeTranscript([
        customTitle('SSO email direct authorization'),
        customTitle('wests'),
      ]);
      const { config, persistSessionTitle } = createConfig(transcriptPath);

      await autoNameSessionFromPlan('Implement the plan.', config);

      expect(persistSessionTitle).not.toHaveBeenCalled();
    });

    it('ignores custom titles that belong to another session', async () => {
      const transcriptPath = writeTranscript([
        { type: 'custom-title', sessionId: 'other', customTitle: 'other' },
      ]);
      const { config, persistSessionTitle } = createConfig(transcriptPath);

      await autoNameSessionFromPlan('Implement the plan.', config);

      expect(persistSessionTitle).toHaveBeenCalledWith(
        'Refactor auth pipeline',
      );
    });

    it('does not overwrite a custom title written while the name is generated', async () => {
      const transcriptPath = writeTranscript([]);
      const { config, inference, persistSessionTitle, setTopic } =
        createConfig(transcriptPath, {
          onInference: () =>
            fs.appendFileSync(
              transcriptPath,
              JSON.stringify(customTitle('wests')) + '\n',
            ),
        });

      await autoNameSessionFromPlan('Implement the plan.', config);

      expect(inference).toHaveBeenCalledTimes(1);
      expect(setTopic).not.toHaveBeenCalled();
      expect(persistSessionTitle).not.toHaveBeenCalled();
    });
  });
});
