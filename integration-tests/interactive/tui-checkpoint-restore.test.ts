/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { startFakeOpenAIServer, fakeToolCall } from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import {
  InteractiveSession,
  sendAboutUntilRendered,
} from './interactive-session.js';

const root = resolve(import.meta.dirname, '../..');
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
async function until(check: () => boolean, reason: string) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(reason);
    await new Promise((done) => setTimeout(done, 100));
  }
}

it(`H11a real model edit creates, hot-restores and cold-resumes its product checkpoint without resurrecting discarded context (${runtime}+${renderer})`, async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-h11a-')));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  const runtimeDir = join(scratch, 'runtime');
  const output =
    process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
    join(root, '.qwen/e2e-tests/checkpoint-restore');
  for (const dir of [workspace, home, runtimeDir, output])
    mkdirSync(dir, { recursive: true });
  const evidence = mkdtempSync(join(output, `${runtime}-${renderer}-`));
  const file = join(workspace, 'owned-checkpoint.txt');
  const bytes = 'H11A_ORIGINAL_BYTES\n';
  const edited = 'H11A_EDITED_BYTES\n';
  const facts: Record<string, unknown> = {
    scope:
      'hot restore plus same-session cold resume; direct live Symbol IDs not directly observed',
  };
  const hookState = join(scratch, 'hook-state');
  mkdirSync(hookState);
  const oldMarker = 'H11A_REAL_EDIT_OLD1';
  const newMarker = 'H11A_REAL_EDIT_NEW2';
  const hookEvents = (): Array<{
    input: { tool_call_id?: string; tool_name: string; tool_input: unknown };
    count: number;
    marker: string;
  }> =>
    existsSync(join(hookState, 'events.jsonl'))
      ? readFileSync(join(hookState, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const editArgs = {
    file_path: file,
    old_string: 'H11A_ORIGINAL_BYTES',
    new_string: 'H11A_EDITED_BYTES',
  };
  const checkpointDir = new Storage(
    workspace,
    runtimeDir,
  ).getProjectTempCheckpointsDir();
  type Journal = {
    uuid: string;
    sessionId: string;
    parentUuid?: string | null;
    type?: string;
    subtype?: string;
    message?: {
      parts?: Array<{ text?: string; functionResponse?: { name?: string } }>;
    };
    toolCallResult?: { callId?: string; status?: string };
    systemPayload?: {
      uiEvent?: {
        'event.name'?: string;
        call_id?: string;
        function_name?: string;
        function_args?: unknown;
        status?: string;
        execution_status?: string;
        success?: boolean;
        decision?: string;
      };
      snapshots?: Array<{
        promptId: string;
        trackedFileBackups: Record<string, { backupFileName: string | null }>;
      }>;
    };
  };
  const files = (directory: string): string[] =>
    existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
          const file = join(directory, entry.name);
          return entry.isDirectory() ? files(file) : [file];
        })
      : [];
  const journals = (): Journal[] =>
    files(runtimeDir)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) => {
        const raw = readFileSync(file, 'utf8');
        return raw
          .slice(0, raw.lastIndexOf('\n') + 1)
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Journal);
      });
  const editResults = () =>
    journals().filter(
      (record) =>
        record.type === 'tool_result' &&
        record.message?.parts?.some(
          (part) => part.functionResponse?.name === 'edit',
        ),
    );

  let failure: unknown;
  let checkpoint: unknown;
  const editCalls = () =>
    journals().filter(
      (record) =>
        record.type === 'system' &&
        record.subtype === 'ui_telemetry' &&
        record.systemPayload?.uiEvent?.['event.name'] ===
          'qwen-code.tool_call' &&
        record.systemPayload.uiEvent.function_name === 'edit',
    );
  let screen = '';
  const server = await startFakeOpenAIServer(({ requestIndex }) => {
    if (requestIndex === 0)
      return {
        toolCalls: [
          fakeToolCall('read_file', { file_path: file }, 'h11a-read'),
        ],
      };
    if (requestIndex === 1)
      return { toolCalls: [fakeToolCall('edit', editArgs, 'h11a-edit')] };
    if (requestIndex === 2) return { content: 'H11A_INITIAL_EDIT_DONE' };
    if (requestIndex === 3) return { content: 'H11A_FOLLOWUP_DISTINCT_DONE' };
    if (requestIndex === 4) return { content: 'H11A_COLD_RESUME_DONE' };
    return { content: 'H11A_UNEXPECTED_CONTINUATION' };
  });
  let session: InteractiveSession | undefined;
  const start = async (resume?: string) =>
    InteractiveSession.start({
      cwd: workspace,
      cols: 100,
      rows: 50,
      inheritEnv: false,
      env: {
        H11A_HOOK_STATE: hookState,
        H11A_HOOK_FILE: file,
        PATH: process.env['PATH'],
        HOME: scratch,
        QWEN_HOME: home,
        QWEN_RUNTIME_DIR: runtimeDir,
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        QWEN_CODE_LANG: 'en',
        QWEN_SANDBOX: 'false',
        QWEN_CODE_DISABLE_CRON: '1',
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
      },
      command: {
        bin: runtime,
        args: [
          join(root, 'dist/cli.js'),
          '--auth-type',
          'openai',
          '--openai-api-key',
          'fixture',
          '--openai-base-url',
          server.baseUrl,
          '--model',
          'qwen-vl-baseline',
          '--approval-mode',
          'default',
          ...(resume ? ['--resume', resume] : []),
        ],
      },
    });
  try {
    json(join(home, 'settings.json'), {
      $version: 4,
      security: {
        auth: { selectedType: 'openai' },
        folderTrust: { enabled: false },
      },
      general: { enableAutoUpdate: false, showSessionRecap: false },
      ui: { enableFollowupSuggestions: false },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      experimental: { mods: false },
      disableAllHooks: false,
      hooks: {
        PostToolUse: [
          {
            matcher: '^edit$',
            hooks: [
              {
                type: 'command',
                command: `node '${join(import.meta.dirname, '../fixtures/checkpoint-edit-marker.mjs')}'`,
                name: 'h11a-real-edit-marker',
                timeout: 5000,
              },
            ],
          },
        ],
      },
    });
    session = await start();
    await sendAboutUntilRendered(session);
    // Seed only real workspace bytes after startup; checkpoint stays product-owned.
    writeFileSync(file, bytes);
    expect(existsSync(checkpointDir) ? readdirSync(checkpointDir) : []).toEqual(
      [],
    );
    await session.idle(150, 750);
    await session.send('H11A_CREATE_REAL_CHECKPOINT');
    screen = await session.waitForScreen(
      (value) =>
        value.includes('Apply this change?') &&
        value.includes('Yes, allow once'),
      'actual edit awaiting approval',
      30000,
    );
    expect(screen).toMatch(/✓\s+Read owned-checkpoint\.txt(?:\s|$)/);
    expect(screen).not.toMatch(/\bReadFile\s+owned-checkpoint\.txt/);
    expect(server.requests).toHaveLength(2);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    await until(
      () =>
        existsSync(checkpointDir) &&
        readdirSync(checkpointDir).some((name) => name.endsWith('.json')),
      'product creates a full edit checkpoint',
    );
    const names = readdirSync(checkpointDir).filter((name) =>
      name.endsWith('.json'),
    );
    expect(names).toHaveLength(1);
    const saved = JSON.parse(
      readFileSync(join(checkpointDir, names[0]), 'utf8'),
    );
    checkpoint = saved;
    json(join(evidence, 'product-checkpoint.json'), {
      name: names[0],
      value: saved,
    });
    expect(saved.toolCall).toEqual({
      callId: 'h11a-edit',
      name: 'edit',
      args: editArgs,
    });
    expect(saved.filePath).toBe(file);
    expect(typeof saved.promptId).toBe('string');
    expect(saved.promptId.length).toBeGreaterThan(0);
    expect(Array.isArray(saved.history) && saved.history.length > 0).toBe(true);
    expect(
      Array.isArray(saved.clientHistory) && saved.clientHistory.length > 0,
    ).toBe(true);
    expect(saved.promptIds).toHaveLength(saved.clientHistory.length);
    expect(saved.promptIds).toContain(saved.promptId);
    expect(
      saved.history.some(
        (item: { type?: string; text?: string; promptId?: string }) =>
          item.type === 'user' &&
          item.text?.includes('H11A_CREATE_REAL_CHECKPOINT') &&
          item.promptId === saved.promptId,
      ),
    ).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(server.requests).toHaveLength(2);
    const checkpointPath = join(checkpointDir, names[0]);
    const originalCheckpoint = readFileSync(checkpointPath);
    const allClosed = () =>
      server.requests.every(
        (request) =>
          request.transport.closedAt !== undefined &&
          request.transport.writableEndedAtClose === true,
      );
    await session.idle();
    session.pressKey('\r');
    await until(
      () =>
        readFileSync(file, 'utf8') === edited &&
        server.requests.length === 3 &&
        allClosed(),
      'initial approved edit B and three completed model requests',
    );
    await session.waitForScreen(
      (value) =>
        value.includes('H11A_INITIAL_EDIT_DONE') &&
        !value.includes('Yes, allow once'),
      'initial edit completed with no active approval',
      15000,
    );
    await until(
      () => editResults().length === 1,
      'one actual initial edit result recorded',
    );
    const initialEdits = editResults();
    expect(initialEdits[0].toolCallResult?.status).toBe('success');
    expect(typeof initialEdits[0].toolCallResult?.callId).toBe('string');
    let backup: { sessionId: string; path: string; name: string } | undefined;
    await until(() => {
      for (const record of journals()) {
        if (
          record.type !== 'system' ||
          record.subtype !== 'file_history_snapshot'
        )
          continue;
        for (const snapshot of record.systemPayload?.snapshots ?? []) {
          const name =
            snapshot.promptId === saved.promptId
              ? snapshot.trackedFileBackups[relative(workspace, file)]
                  ?.backupFileName
              : undefined;
          if (!name) continue;
          const path = join(home, 'file-history', record.sessionId, name);
          if (existsSync(path) && readFileSync(path, 'utf8') === bytes)
            backup = { sessionId: record.sessionId, path, name };
        }
      }
      return backup !== undefined;
    }, 'actual tracked-edit backup A under the same promptId');
    const initialEditCalls = editCalls();
    expect(initialEditCalls).toHaveLength(1);
    expect(initialEditCalls[0].systemPayload?.uiEvent?.call_id).toBe(
      initialEdits[0].toolCallResult?.callId,
    );
    expect(initialEditCalls[0].systemPayload?.uiEvent?.function_args).toEqual(
      editArgs,
    );
    expect(initialEditCalls[0].systemPayload?.uiEvent?.execution_status).toBe(
      'success',
    );
    const initialCallIds = new Set(
      initialEditCalls.map((record) => record.systemPayload?.uiEvent?.call_id),
    );
    facts.initialEditResults = initialEdits;
    facts.initialEditCalls = initialEditCalls;
    facts.backup = backup;
    json(join(evidence, 'initial-journal.json'), journals());
    await session.idle();
    await session.send('/restore');
    const listing = await session.waitForScreen(
      (value) => value.includes('Available tool calls to restore:'),
      'actual checkpoint listing',
      15000,
    );
    expect(listing.replace(/\s+/g, '')).toContain(names[0].slice(0, -5));
    expect(server.requests).toHaveLength(3);
    await session.idle();
    const restoreInput = '/restore ' + names[0].slice(0, -5);
    for (const char of restoreInput) {
      session.pressKey(char);
      await new Promise((done) => setTimeout(done, 5));
    }
    await session.idle();
    const composerBeforeDismiss = (await session.viewport())
      .split('\n')
      .findLast((line) => /^\s*>\s*\/restore\b/.test(line));
    facts.restoreComposerBeforeDismiss = composerBeforeDismiss;
    expect(composerBeforeDismiss?.trim().replace(/^>\s*/, '')).toBe(
      restoreInput,
    );
    session.pressKey('\x1b');
    await session.idle();
    const composerAfterDismiss = (await session.viewport())
      .split('\n')
      .findLast((line) => /^\s*>\s*\/restore\b/.test(line));
    facts.restoreComposerAfterDismiss = composerAfterDismiss;
    expect(composerAfterDismiss?.trim().replace(/^>\s*/, '')).toBe(
      restoreInput,
    );
    session.pressKey('\r');
    const replayApproval = await session.waitForScreen(
      (value) =>
        value.includes('Apply this change?') &&
        value.includes('Yes, allow once'),
      'new replay awaiting approval after original edit completed',
      30000,
    );
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(server.requests).toHaveLength(3);
    facts.replayApproval = replayApproval;
    await session.idle();
    session.pressKey('\r');
    await until(
      () => readFileSync(file, 'utf8') === edited && editCalls().length === 2,
      'one local replay edit completion',
    );
    const replayEdits = editCalls().filter(
      (record) => !initialCallIds.has(record.systemPayload?.uiEvent?.call_id),
    );
    expect(replayEdits).toHaveLength(1);
    expect(replayEdits[0].systemPayload?.uiEvent?.status).toBe('success');
    expect(replayEdits[0].systemPayload?.uiEvent?.execution_status).toBe(
      'success',
    );
    expect(replayEdits[0].systemPayload?.uiEvent?.success).toBe(true);
    expect(replayEdits[0].systemPayload?.uiEvent?.function_args).toEqual(
      editArgs,
    );
    expect(typeof replayEdits[0].systemPayload?.uiEvent?.call_id).toBe(
      'string',
    );
    expect(replayEdits[0].uuid).not.toBe(initialEditCalls[0].uuid);
    await session.idle();
    expect(await session.viewport()).not.toContain('Yes, allow once');
    expect(await session.viewport()).not.toContain('H11A_INITIAL_EDIT_DONE');
    expect(server.requests).toHaveLength(3);
    expect(
      readdirSync(checkpointDir).filter((name) => name.endsWith('.json')),
    ).toEqual(names);
    expect(readFileSync(checkpointPath)).toEqual(originalCheckpoint);
    facts.replayEditResults = replayEdits;
    await session.send('H11A_EXPLICIT_FOLLOWUP');
    await session.waitForScreen(
      (value) => value.includes('H11A_FOLLOWUP_DISTINCT_DONE'),
      'one explicit followup response',
      30000,
    );
    await until(
      () => server.requests.length === 4 && allClosed(),
      'exactly four completed model transports',
    );
    const messages = server.requests[3].body['messages'] as Array<{
      role?: string;
      content?: unknown;
    }>;
    const originalEditId = 'h11a-edit';
    const restoredToolResults = (
      messages as Array<{
        role?: string;
        tool_call_id?: string;
        content?: unknown;
      }>
    ).filter(
      (message) =>
        message.role === 'tool' && message.tool_call_id === originalEditId,
    );
    const initialToolResults = (
      server.requests[2].body['messages'] as Array<{
        role?: string;
        tool_call_id?: string;
        content?: unknown;
      }>
    ).filter(
      (message) =>
        message.role === 'tool' && message.tool_call_id === originalEditId,
    );
    expect(initialToolResults).toHaveLength(1);
    expect(restoredToolResults).toHaveLength(1);
    // The real PostToolUse hook distinguishes initial and local replay output.
    // Normalizing that one marker must preserve every other actual payload field.
    expect(JSON.stringify(initialToolResults[0].content)).toContain(
      `The file: ${file} has been updated.`,
    );
    const initialContent = JSON.stringify(initialToolResults[0].content);
    const replayContent = JSON.stringify(restoredToolResults[0].content);
    expect(initialContent.split(oldMarker)).toHaveLength(2);
    expect(initialContent).not.toContain(newMarker);
    expect(replayContent.split(newMarker)).toHaveLength(2);
    expect(replayContent).not.toContain(oldMarker);
    expect(JSON.parse(replayContent.replace(newMarker, oldMarker))).toEqual(
      initialToolResults[0].content,
    );
    const observedHooks = hookEvents();
    expect(observedHooks).toHaveLength(2);
    expect(observedHooks.map((event) => [event.count, event.marker])).toEqual([
      [1, oldMarker],
      [2, newMarker],
    ]);
    expect(observedHooks[0].input.tool_call_id).toBe(originalEditId);
    expect(observedHooks[1].input.tool_call_id).toBe(
      replayEdits[0].systemPayload?.uiEvent?.call_id,
    );
    expect(observedHooks[1].input.tool_call_id).not.toBe(originalEditId);
    for (const event of observedHooks) {
      expect(event.input.tool_name).toBe('edit');
      expect(event.input.tool_input).toEqual(editArgs);
    }
    facts.realPostToolHookEvents = observedHooks;
    json(join(evidence, 'real-post-tool-hook-events.json'), observedHooks);
    expect(JSON.stringify(restoredToolResults[0].content)).toContain(
      JSON.stringify(edited).slice(1, -1),
    );
    expect(JSON.stringify(messages)).not.toContain(
      'Tool execution result was not recorded',
    );
    expect(JSON.stringify(messages)).not.toContain(
      'Treat as failure and retry if needed',
    );
    facts.restoredOriginalCallResult = restoredToolResults[0];
    const userWire = messages
      .filter((message) => message.role === 'user')
      .map((message) => JSON.stringify(message.content))
      .join('\n');
    expect(userWire.split('H11A_CREATE_REAL_CHECKPOINT').length - 1).toBe(1);
    expect(userWire.split('H11A_EXPLICIT_FOLLOWUP').length - 1).toBe(1);
    expect(userWire).not.toContain('/restore');
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(readFileSync(checkpointPath)).toEqual(originalCheckpoint);
    expect(
      readdirSync(checkpointDir).filter((name) => name.endsWith('.json')),
    ).toEqual(names);
    json(join(evidence, 'final-journal.json'), journals());
    await session.idle();
    await session.send('/quit');
    await until(
      () => session!.exitResult() !== undefined,
      'natural quit before cleanup',
    );
    expect(session.exitResult()).toEqual({ exitCode: 0, signal: 0 });
    facts.naturalExitBeforeCleanup = session.exitResult();
    expect(server.requests).toHaveLength(4);
    expect(editCalls()).toHaveLength(2);
    expect(
      editCalls().filter(
        (record) => !initialCallIds.has(record.systemPayload?.uiEvent?.call_id),
      ),
    ).toHaveLength(1);

    // A second real product process uses the SAME recorded identity and owned roots.
    const resumedSessionId = initialEdits[0].sessionId;
    expect(resumedSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    facts.hotNaturalExit = session.exitResult();
    writeFileSync(join(evidence, 'hot-terminal.ansi'), session.output());
    json(join(evidence, 'pre-cold-journal.json'), journals());
    await session.close();
    session = await start(resumedSessionId);
    await sendAboutUntilRendered(session);
    expect(server.requests).toHaveLength(4);
    const resumedScreen = await session.viewport();
    facts.coldInitialScreen = resumedScreen;
    expect(resumedScreen).toMatch(/✓\s+Read owned-checkpoint\.txt(?:\s|$)/);
    expect(resumedScreen).not.toMatch(/\bReadFile\s+owned-checkpoint\.txt/);
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(editCalls()).toHaveLength(2);
    await session.idle();
    await session.send('H11A_COLD_EXPLICIT_FOLLOWUP');
    await session.waitForScreen(
      (value) => value.includes('H11A_COLD_RESUME_DONE'),
      'one cold resumed explicit response',
      30000,
    );
    await until(
      () => server.requests.length === 5 && allClosed(),
      'exactly five completed model requests including cold resume',
    );
    const coldMessages = server.requests[4].body['messages'] as Array<{
      role?: string;
      tool_call_id?: string;
      content?: unknown;
    }>;
    json(join(evidence, 'cold-wire.json'), coldMessages);
    expect(resumedScreen).toContain('H11A_FOLLOWUP_DISTINCT_DONE');
    expect(resumedScreen).not.toContain('H11A_INITIAL_EDIT_DONE');
    const coldAssistant = coldMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => JSON.stringify(message.content))
      .join('\n');
    expect(coldAssistant).not.toContain('H11A_INITIAL_EDIT_DONE');
    expect(coldAssistant.split('H11A_FOLLOWUP_DISTINCT_DONE').length - 1).toBe(
      1,
    );
    const coldUsers = coldMessages
      .filter((message) => message.role === 'user')
      .map((message) => JSON.stringify(message.content))
      .join('\n');
    for (const text of [
      'H11A_CREATE_REAL_CHECKPOINT',
      'H11A_EXPLICIT_FOLLOWUP',
      'H11A_COLD_EXPLICIT_FOLLOWUP',
    ])
      expect(coldUsers.split(text).length - 1).toBe(1);
    expect(coldUsers).not.toContain('/restore');
    const coldToolResults = coldMessages.filter(
      (message) =>
        message.role === 'tool' && message.tool_call_id === originalEditId,
    );
    expect(coldToolResults).toHaveLength(1);
    expect(coldToolResults[0].content).toEqual(restoredToolResults[0].content);
    expect(
      JSON.stringify(coldToolResults[0].content).split(newMarker),
    ).toHaveLength(2);
    expect(JSON.stringify(coldToolResults[0].content)).not.toContain(oldMarker);
    expect(hookEvents()).toHaveLength(2);
    expect(JSON.stringify(coldMessages)).not.toContain(
      'Tool execution result was not recorded',
    );
    expect(JSON.stringify(coldMessages)).not.toContain(
      'Treat as failure and retry if needed',
    );
    await until(
      () =>
        journals().some(
          (record) =>
            record.type === 'user' &&
            record.message?.parts?.some(
              (part) => part.text === 'H11A_COLD_EXPLICIT_FOLLOWUP',
            ),
        ),
      'actual cold resumed user journal record',
    );
    const persisted = journals();
    const coldRecords = persisted.filter(
      (record) =>
        record.type === 'user' &&
        record.message?.parts?.some(
          (part) => part.text === 'H11A_COLD_EXPLICIT_FOLLOWUP',
        ),
    );
    expect(coldRecords).toHaveLength(1);
    expect(coldRecords[0].sessionId).toBe(resumedSessionId);
    const recordsById = new Map(
      persisted
        .filter((record) => typeof record.uuid === 'string')
        .map((record) => [record.uuid, record]),
    );
    const ancestry: Journal[] = [];
    const seen = new Set<string>();
    let cursor: Journal | undefined = coldRecords[0];
    while (cursor) {
      expect(seen.has(cursor.uuid)).toBe(false);
      seen.add(cursor.uuid);
      ancestry.push(cursor);
      if (!cursor.parentUuid) break;
      expect(recordsById.has(cursor.parentUuid)).toBe(true);
      cursor = recordsById.get(cursor.parentUuid);
    }
    // Observe real parent pointers, without simulating or rewriting session reconstruction.
    expect(
      ancestry.some((record) =>
        record.message?.parts?.some(
          (part) => part.text === 'H11A_INITIAL_EDIT_DONE',
        ),
      ),
    ).toBe(false);
    json(join(evidence, 'cold-active-user-ancestry.json'), ancestry);
    facts.coldSessionId = resumedSessionId;
    facts.coldToolResult = coldToolResults[0];
    // The existing startup cleanup removes ephemeral command checkpoints.
    // Durable backup bytes and the active journal snapshot must survive it.
    expect(
      existsSync(checkpointDir)
        ? readdirSync(checkpointDir).filter((name) => name.endsWith('.json'))
        : [],
    ).toEqual([]);
    expect(backup).toBeDefined();
    expect(readFileSync(backup!.path, 'utf8')).toBe(bytes);
    expect(
      ancestry.some((record) =>
        record.systemPayload?.snapshots?.some(
          (snapshot) =>
            snapshot.promptId === saved.promptId &&
            snapshot.trackedFileBackups[relative(workspace, file)]
              ?.backupFileName === backup!.name,
        ),
      ),
    ).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(editCalls()).toHaveLength(2);
    await session.idle();
    await session.send('/quit');
    await until(
      () => session!.exitResult() !== undefined,
      'cold natural quit before cleanup',
    );
    expect(session.exitResult()).toEqual({ exitCode: 0, signal: 0 });
    facts.coldNaturalExit = session.exitResult();
    expect(server.requests).toHaveLength(5);
    expect(editCalls()).toHaveLength(2);
  } catch (error) {
    failure = error;
  } finally {
    for (const close of [() => session?.close(), () => server.close()]) {
      try {
        await close();
      } catch (error) {
        failure = new AggregateError(
          [failure, error].filter(Boolean),
          'H11a creation or cleanup failed',
        );
      }
    }
    if (session)
      writeFileSync(join(evidence, 'terminal.ansi'), session.output());
    json(join(evidence, 'closing-real-hook-events.json'), hookEvents());
    if (existsSync(join(hookState, 'events.jsonl')))
      writeFileSync(
        join(evidence, 'raw-hook-events.jsonl'),
        readFileSync(join(hookState, 'events.jsonl')),
      );
    json(join(evidence, 'closing-journal.json'), journals());
    for (const [index, path] of files(runtimeDir)
      .filter((path) => path.endsWith('.jsonl'))
      .entries())
      writeFileSync(
        join(evidence, `raw-journal-${index}.jsonl`),
        readFileSync(path),
      );
    json(join(evidence, 'result.json'), {
      result: failure ? 'FAIL' : 'PASS',
      failure: failure && String(failure),
      runtime,
      renderer,
      checkpoint,
      facts,
      screen,
      fileBytes: existsSync(file) ? readFileSync(file, 'utf8') : null,
      requests: server.requests,
      cleanupExit: session?.exitResult(),
      scope:
        'actual product creation + approved edit + tracked backup A + hot restore to A + one local edit replay to B + explicit followup + naturalquit. same-session cold resume active context/ancestry,5HTTP/2naturalquit. Physical JSONL erasure/direct live Symbol IDs NOT_PROVEN',
    });
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failure) throw failure;
}, 120_000);
