/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonSessionClient, type DaemonEvent } from '@qwen-code/sdk';
import {
  makeTempWorkspace,
  spawnDaemon,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = path.resolve(
  __dirname,
  '../fixtures/mock-acp-child/agent.mjs',
);

let activeDaemon: SpawnedDaemon | undefined;

afterEach(async () => {
  await activeDaemon?.dispose();
  activeDaemon = undefined;
});

function updateKind(event: DaemonEvent): unknown {
  if (event.type !== 'session_update' || !event.data) return undefined;
  return (event.data as { update?: { sessionUpdate?: unknown } }).update
    ?.sessionUpdate;
}

describe('qwen serve live journal recovery', () => {
  it('attributes a truncated live tail and exposes the complete turn after terminal', async () => {
    const workspace = makeTempWorkspace('live-journal-recovery');
    try {
      activeDaemon = await spawnDaemon({
        workspaceCwd: workspace,
        extraArgs: [
          '--max-journal-events',
          '3',
          '--max-journal-bytes',
          String(8 * 1024 * 1024),
        ],
        env: {
          QWEN_CLI_ENTRY: MOCK_AGENT_PATH,
          MOCK_ACP_MODE: 'echo',
          MOCK_ACP_EMIT_CHUNKS: '20',
          MOCK_ACP_PROMPT_DELAY_MS: '1500',
        },
      });
      const created = await activeDaemon.client.createOrAttachSession({
        sessionScope: 'thread',
      });
      const prompt = activeDaemon.client.prompt(created.sessionId, {
        prompt: [{ type: 'text', text: 'recover this complete turn' }],
      });

      let duringTurn: DaemonSessionClient | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const loaded = await DaemonSessionClient.load(
          activeDaemon.client,
          created.sessionId,
          {},
          'live-journal-observer',
        );
        if (
          loaded.replaySnapshot.liveJournal.some(
            (event) => event.type === 'history_truncated',
          )
        ) {
          duringTurn = loaded;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(duringTurn).toBeDefined();
      const marker = duringTurn!.replaySnapshot.liveJournal.find(
        (event) => event.type === 'history_truncated',
      );
      expect(marker).toMatchObject({
        promptId: expect.any(String),
        data: {
          scope: 'live_journal',
          maxEvents: 3,
          fullTranscriptAvailable: true,
        },
      });
      expect(duringTurn!.replaySnapshot.liveJournal).not.toContainEqual(
        expect.objectContaining({
          type: 'session_update',
          data: expect.objectContaining({
            update: expect.objectContaining({
              content: expect.objectContaining({ text: 'chunk-0' }),
            }),
          }),
        }),
      );

      await prompt;
      const repaired = await DaemonSessionClient.load(
        activeDaemon.client,
        created.sessionId,
        {},
        'live-journal-observer',
      );
      const completeReplay = repaired.replaySnapshot.compactedReplay;
      expect(repaired.replaySnapshot.liveJournal).toEqual([]);
      expect(
        completeReplay.find(
          (event) => updateKind(event) === 'user_message_chunk',
        ),
      ).toMatchObject({ promptId: marker?.promptId });
      expect(completeReplay).toContainEqual(
        expect.objectContaining({
          type: 'turn_complete',
          promptId: marker?.promptId,
        }),
      );
      const replayText = JSON.stringify(completeReplay);
      expect(replayText).toContain('chunk-0');
      expect(replayText).toContain('chunk-19');
      expect(completeReplay).not.toContainEqual(
        expect.objectContaining({ type: 'history_truncated' }),
      );
    } finally {
      await activeDaemon?.dispose();
      activeDaemon = undefined;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
