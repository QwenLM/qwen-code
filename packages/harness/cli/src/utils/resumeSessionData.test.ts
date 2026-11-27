/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  beginResumeRead,
  ForkSessionService,
  createBoundedResumeReadState,
  TranscriptStore,
} from '@qwen-code/core';
import { buildResumedSessionData } from './resumeSessionData.js';

it.each([undefined, 'answer'])(
  'preserves bounded candidate and historical selection (%s)',
  async (resumeSessionAt) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-resume-'));
    const file = path.join(dir, 'session.jsonl');
    const store = new TranscriptStore();
    const attempt = await beginResumeRead();
    try {
      const base = { sessionId: 'source', timestamp: '2026-10-28T00:00:00Z' };
      await fs.writeFile(
        file,
        [
          {
            ...base,
            type: 'user',
            uuid: 'prompt',
            parentUuid: null,
            message: { role: 'user', content: 'hello' },
          },
          {
            ...base,
            type: 'assistant',
            uuid: 'answer',
            parentUuid: 'prompt',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'answer' }],
              stop_reason: 'end_turn',
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n'),
      );
      const candidate = (await store
        .repository()
        .readForResume(file, { sessionId: 'source', attempt }))!;
      const fullRead = vi
        .spyOn(store.repository(), 'resolveSession')
        .mockRejectedValue(new Error('unbounded read'));
      const data = await buildResumedSessionData(
        {
          transcriptStore: store,
          sessionId: 'source',
          sessionArtifactProjectRoot: dir,
        },
        {
          sessionPath: file,
          sessionInfo: { id: 'source' },
          messages: [...candidate.messages],
          fileHistorySnapshots: [],
          resumeCandidate: candidate,
          resumeAttempt: attempt,
          transcriptReadState: createBoundedResumeReadState(candidate),
        } as unknown as Parameters<typeof buildResumedSessionData>[1],
        { resumeSessionAt },
      );
      expect(data.resumeCandidate?.attempt).toBe(attempt);
      expect(data.transcriptReadState?.attempt).toBe(attempt);
      expect(data.messages.map((m) => m.uuid)).toEqual(['prompt', 'answer']);
      expect(data.resumeCandidate?.resumeSessionAt).toBe(resumeSessionAt);
      expect(fullRead).not.toHaveBeenCalled();
    } finally {
      attempt.finish();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  'retains raw fork entries only for a mirror (%s)',
  async (sessionMirror) => {
    const entries = [{ type: 'custom-title', customTitle: 'Fork' }];
    const create = vi
      .spyOn(ForkSessionService.prototype, 'createFork')
      .mockResolvedValue({
        sessionId: 'target',
        sessionPath: '/tmp/target.jsonl',
        entries,
        messages: [],
      } as never);
    const store = new TranscriptStore();
    try {
      const data = await buildResumedSessionData(
        {
          transcriptStore: store,
          sessionId: 'target',
          sessionArtifactProjectRoot: '/tmp',
        },
        {
          sessionInfo: { id: 'source' },
          sessionPath: '/tmp/source.jsonl',
        } as never,
        { forkSession: true, sessionMirror },
      );
      expect(data.forkTranscriptEntries).toEqual(
        sessionMirror ? entries : undefined,
      );
    } finally {
      create.mockRestore();
      await store.close();
    }
  },
);
