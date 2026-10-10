/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import { runWithToolCallSource } from '../code-mode/tool-call-runtime.js';
import { SESSION_CONTEXT_TOOL_NAMES } from '../services/session-notes-state.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from '../services/chatRecordingService.js';
import { SessionHistoryService } from '../services/session-history-service.js';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  resetSessionTranscriptIndexCacheForTest,
  SessionTranscriptReader,
  setSessionTranscriptIndexBuildCompleteHookForTest,
} from '../services/session-transcript-reader.js';
import { EVENT_TOOL_CALL } from '../telemetry/constants.js';
import type { UiEvent } from '../telemetry/uiTelemetry.js';
import { SessionContextTool } from './session-context.js';
import { ToolNames } from './tool-names.js';
import { isCodeModeToolCallAllowed } from './code-mode.js';

function fixture(sessionId = 'session') {
  const response = { observed: {} };
  const notes = {
    sessionId,
    captureResponse: () => response,
    assertAvailable: vi.fn(),
    write: vi.fn().mockResolvedValue({
      revision: 'note',
      windowId: 'window',
      sourceLeafUuid: 'input',
    }),
    read: vi.fn().mockResolvedValue(undefined),
    requestReset: vi.fn(),
  };
  const chat = { getSessionNotesService: () => notes };
  const client = { getChat: vi.fn(() => chat) };
  const config = {
    llmClient: client,
    getLlmClient: () => client,
    getSessionId: vi.fn(() => sessionId),
  } as unknown as Config;
  return { config, client, chat, notes, response };
}

describe('session context tools', () => {
  it('captures the response at invocation time and returns a durable write revision', async () => {
    const { config, notes, response } = fixture();
    const tool = new SessionContextTool(config, ToolNames.SESSION_NOTES);
    const signal = new AbortController().signal;
    const result = await tool
      .build({ action: 'write', text: 'checkpoint' })
      .execute(signal);
    expect(notes.write).toHaveBeenCalledWith('checkpoint', response, signal);
    expect(JSON.parse(result.llmContent as string)).toEqual({
      revision: 'note',
      windowId: 'window',
      sourceLeafUuid: 'input',
    });
    expect(result.error).toBeUndefined();
  });

  it.each(['derived config', 'subagent', 'teammate', 'nested exec'])(
    'rejects parent notes access from %s',
    async (context) => {
      const { config, notes } = fixture();
      const scopedConfig =
        context === 'derived config'
          ? (Object.create(config) as Config)
          : config;
      const execute = () =>
        new SessionContextTool(scopedConfig, ToolNames.SESSION_NOTES)
          .build({ action: 'write', text: 'checkpoint' })
          .execute(new AbortController().signal);
      const result =
        context === 'subagent'
          ? await runWithAgentContext('child', execute)
          : context === 'teammate'
            ? await runWithTeammateIdentity(
                {
                  agentId: 'scribe@team',
                  agentName: 'scribe',
                  teamName: 'team',
                  isTeamLead: false,
                },
                execute,
              )
            : context === 'nested exec'
              ? await runWithToolCallSource({ kind: 'code_mode' }, execute)
              : await execute();
      expect(result.error?.message).toContain('owning main chat');
      expect(notes.write).not.toHaveBeenCalled();
    },
  );

  it('rejects an invocation after session rotation', async () => {
    const { config, notes } = fixture();
    const invocation = new SessionContextTool(
      config,
      ToolNames.NEW_CONTEXT,
    ).build({ notes_revision: 'note' });
    vi.mocked(config.getSessionId).mockReturnValue('new-session');
    expect(
      (await invocation.execute(new AbortController().signal)).error,
    ).toBeDefined();
    expect(notes.requestReset).not.toHaveBeenCalled();
  });

  it('does not accept arbitrary paths or malformed operations and exposes only direct code-mode calls', () => {
    const { config } = fixture();
    const notes = new SessionContextTool(config, ToolNames.SESSION_NOTES);
    expect(() => notes.build({ action: 'write' })).toThrow();
    expect(() =>
      notes.build({ action: 'read', path: '/other-session' } as never),
    ).toThrow();
    expect(() =>
      new SessionContextTool(config, ToolNames.SESSION_HISTORY).build({
        action: 'list',
        limit: 100,
      }),
    ).toThrow();
    for (const name of SESSION_CONTEXT_TOOL_NAMES) {
      expect(isCodeModeToolCallAllowed(name, 'model')).toBe(true);
      expect(isCodeModeToolCallAllowed(name, 'code_mode')).toBe(false);
    }
  });
});

describe('session history concurrent recording', () => {
  let runtime: string;
  let transcript: string;
  let recorder: ChatRecordingService;
  let lease: SessionWriterLease;
  let tool: SessionContextTool;
  let seed: ChatRecord;
  let hookCalled: boolean;

  beforeEach(async () => {
    resetSessionTranscriptIndexCacheForTest();
    runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-history-tool-'));
    const workspace = path.join(runtime, 'workspace');
    await fs.mkdir(workspace);
    const sessionId = randomUUID();
    const storage = new Storage(workspace, runtime);
    transcript = path.join(
      storage.getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
    lease = await SessionWriterLease.acquire({
      runtimeBaseDir: runtime,
      sessionId,
      transcriptPath: transcript,
      processKind: 'unknown',
      reclaimPolicy: 'never',
    });
    const { config, chat } = fixture(sessionId);
    Object.assign(config, {
      storage,
      getProjectRoot: () => workspace,
      getCliVersion: () => 'test',
      getResumedSessionData: () => undefined,
      getFastModel: () => undefined,
      isInteractive: () => false,
      getChatRecordingService: () => recorder,
    });
    recorder = new ChatRecordingService(config);
    recorder.activate(lease);
    recorder.recordUserMessage([{ text: 'RECOVERY_KEY=canary' }]);
    await recorder.flush();
    seed = JSON.parse((await fs.readFile(transcript, 'utf8')).trim());
    vi.spyOn(lease, 'appendJsonLine');
    const history = new SessionHistoryService(
      new SessionTranscriptReader(workspace, undefined, runtime),
      sessionId,
      () => 10000,
    );
    Object.assign(chat, { getSessionHistoryService: () => history });
    tool = new SessionContextTool(config, ToolNames.SESSION_HISTORY);
    hookCalled = false;
  });

  afterEach(async () => {
    resetSessionTranscriptIndexCacheForTest();
    await recorder?.close();
    vi.restoreAllMocks();
    await fs.rm(runtime, { recursive: true, force: true });
  });

  function queueWritesDuringRead(afterQueue: () => void = () => {}) {
    setSessionTranscriptIndexBuildCompleteHookForTest(async (file) => {
      if (file !== transcript) return;
      setSessionTranscriptIndexBuildCompleteHookForTest(() => {});
      hookCalled = true;
      recorder.recordUiTelemetryEvent({
        'event.name': EVENT_TOOL_CALL,
        'event.timestamp': new Date().toISOString(),
        function_name: 'read_file',
        function_args: {},
        duration_ms: 1,
        status: 'success',
        success: true,
        prompt_id: 'test',
        tool_type: 'native',
      } as unknown as UiEvent);
      recorder.recordUserMessage([{ text: 'LATER_RECORD=durable' }]);
      // Let an unguarded append start before checking that writes are deferred.
      await Promise.resolve();
      expect(lease.appendJsonLine).not.toHaveBeenCalled();
      afterQueue();
    });
  }

  async function expectQueuedWritesPersisted() {
    expect(hookCalled).toBe(true);
    await recorder.flush();
    const records: ChatRecord[] = (await fs.readFile(transcript, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual(seed);
    expect(records[1].subtype).toBe('ui_telemetry');
    expect(records[1].parentUuid).toBe(seed.uuid);
    expect(records[2].parentUuid).toBe(records[1].uuid);
    expect(records[2].message?.parts).toEqual([
      { text: 'LATER_RECORD=durable' },
    ]);
    const next = await tool
      .build({ action: 'search', query: 'LATER_RECORD' })
      .execute(new AbortController().signal);
    expect(next.error).toBeUndefined();
    expect(next.llmContent).toContain('LATER_RECORD=durable');
  }

  it.each(['search', 'list', 'read'] as const)(
    'keeps %s stable while telemetry and messages are queued',
    async (action) => {
      queueWritesDuringRead();
      const result = await tool
        .build({
          action,
          ...(action === 'search' ? { query: 'RECOVERY_KEY' } : {}),
          ...(action === 'read' ? { ref: `${seed.uuid}:0` } : {}),
        })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('RECOVERY_KEY=canary');
      expect(result.llmContent).not.toContain('LATER_RECORD');
      await expectQueuedWritesPersisted();
    },
  );

  it.each(['error', 'abort'])(
    'releases queued writes after a history %s',
    async (outcome) => {
      const controller = new AbortController();
      const failure = new Error('controlled history failure');
      queueWritesDuringRead(() => {
        if (outcome === 'abort') controller.abort(failure);
        else throw failure;
      });
      const result = await tool
        .build({ action: 'list' })
        .execute(controller.signal);
      expect(result.error?.message).toBe(failure.message);
      await expectQueuedWritesPersisted();
    },
  );
});
