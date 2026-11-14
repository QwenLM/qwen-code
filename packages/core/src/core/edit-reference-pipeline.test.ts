/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Content } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { EditTool } from '../tools/edit.js';
import {
  normalizeEditReference,
  syncEditReferenceDelivery,
} from '../tools/edit-references.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolConfirmationOutcome, type ToolResult } from '../tools/tools.js';
import {
  CoreToolScheduler,
  type CompletedToolCall,
  type ToolCall,
  type WaitingToolCall,
} from './coreToolScheduler.js';
import { LlmChat } from './llm-chat.js';

const target =
  "function sample() {\n  const value = 'original';\n  return value;\n}";
const next = target.replace('original', 'changed');
const source = `header\n${target}\nfooter\n`;
const signal = () => new AbortController().signal;

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

function idFrom(result: ToolResult, kind: 'read' | 'recovery'): string {
  const id = strings(result.llmContent)
    .join('\n')
    .match(new RegExp(`${kind}_id\\s*:\\s*"((?:rd|er)_[a-zA-Z0-9-]+)"`))?.[1];
  expect(
    id,
    `Expected a ${kind} reference from the real producer`,
  ).toBeDefined();
  return id!;
}

describe('edit references across scheduler and history boundaries', () => {
  let directory: string;
  let file: string;
  let config: Config;
  let read: ReadFileTool;
  let edit: EditTool;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'edit-reference-pipeline-'));
    file = join(directory, 'fixture.txt');
    writeFileSync(file, source);
    config = makeFakeConfig({
      targetDir: directory,
      cwd: directory,
      approvalMode: ApprovalMode.YOLO,
      usageStatisticsEnabled: false,
      chatRecording: false,
      disableAllHooks: true,
      interactive: true,
    });
    const registry = new ToolRegistry(config);
    read = new ReadFileTool(config);
    edit = new EditTool(config);
    registry.registerTool(read);
    registry.registerTool(edit);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    vi.spyOn(config.getFileHistoryService(), 'trackEdit').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  async function recovery() {
    await read.build({ file_path: file }).execute(signal());
    const failed = await edit
      .build({
        file_path: file,
        old_string: target.replace('original', 'orignal'),
        new_string: next,
      })
      .execute(signal());
    const id = idFrom(failed, 'recovery');
    return { failed, id, wire: { file_path: file, recovery_id: id } };
  }

  function scheduler() {
    const completed = vi.fn<(calls: CompletedToolCall[]) => void>();
    const updates: ToolCall[] = [];
    let sequence = 0;
    const instance = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: (calls) => updates.push(...calls),
      getPreferredEditor: () => undefined,
      onEditorClose: () => {},
    });
    const schedule = async (args: Record<string, unknown>) => {
      completed.mockClear();
      updates.length = 0;
      await instance.schedule(
        {
          callId: `edit-reference-${++sequence}`,
          name: 'edit',
          args,
          isClientInitiated: false,
          prompt_id: 'edit-reference-pipeline',
        },
        signal(),
      );
    };
    const settled = async () => {
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
      return completed.mock.calls[0][0][0];
    };
    const run = async (args: Record<string, unknown>) => {
      await schedule(args);
      return settled();
    };
    const waiting = () =>
      updates.findLast(
        (call): call is WaitingToolCall => call.status === 'awaiting_approval',
      );
    return { run, schedule, settled, waiting };
  }

  function hooks(
    output: (
      event: string,
      input: Record<string, unknown>,
    ) => Record<string, unknown>,
  ) {
    const request = vi.fn(
      async ({
        eventName,
        input,
      }: {
        eventName: string;
        input: Record<string, unknown>;
      }) => ({
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: eventName,
        success: true,
        output: output(eventName, input),
      }),
    );
    config.setMessageBus({ request } as unknown as MessageBus);
    vi.spyOn(config, 'getDisableAllHooks').mockReturnValue(false);
    vi.spyOn(config, 'hasHooksForEvent').mockReturnValue(true);
    return request;
  }

  it('does not activate an ID alone or target fragments split across delivery slots', async () => {
    const { failed, wire, id } = await recovery();
    expect(() => normalizeEditReference(config, wire)).toThrow();
    syncEditReferenceDelivery(config, [`recovery_id: "${id}"`]);
    expect(() => normalizeEditReference(config, wire)).toThrow();
    const block = failed.recoveryText!;
    expect(block).toContain(target);
    syncEditReferenceDelivery(config, [
      block.slice(0, block.length / 2),
      block.slice(block.length / 2),
    ]);
    expect(() => normalizeEditReference(config, wire)).toThrow();
    syncEditReferenceDelivery(config, strings(failed.llmContent));
    expect((await scheduler().run(wire)).status).toBe('success');
    expect(readFileSync(file, 'utf8')).toBe(source.replace(target, next));
  });

  it('expands before PreToolUse and honors its replacement text', async () => {
    const { failed, wire } = await recovery();
    syncEditReferenceDelivery(config, strings(failed.llmContent));
    const hookNew = target.replace('original', 'from-hook');
    const request = hooks((event, input) => {
      if (event !== 'PreToolUse') return {};
      const actual = input['tool_input'] as Record<string, unknown>;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { ...actual, new_string: hookNew },
        },
      };
    });
    expect((await scheduler().run(wire)).status).toBe('success');
    const pre = request.mock.calls.find(
      ([call]) => call.eventName === 'PreToolUse',
    );
    expect(pre?.[0].input['tool_input']).toEqual({
      file_path: file,
      old_string: target,
      new_string: next,
    });
    expect(wire).not.toHaveProperty('old_string');
    expect(readFileSync(file, 'utf8')).toBe(source.replace(target, hookNew));
  });

  it('drops reference authority when a hook changes the selected old text', async () => {
    const { failed, wire } = await recovery();
    syncEditReferenceDelivery(config, strings(failed.llmContent));
    config.getFileReadCache().clear();
    hooks((event) =>
      event === 'PreToolUse'
        ? {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: {
                file_path: file,
                old_string: 'footer',
                new_string: 'changed-footer',
              },
            },
          }
        : {},
    );
    const call = await scheduler().run(wire);
    expect(call.status).toBe('error');
    expect(call.response.errorType).toBe('edit_requires_prior_read');
    expect(readFileSync(file, 'utf8')).toBe(source);
  });

  it('uses the actual replacement returned by a PermissionRequest hook', async () => {
    const { failed, wire } = await recovery();
    syncEditReferenceDelivery(config, strings(failed.llmContent));
    config.setApprovalMode(ApprovalMode.DEFAULT);
    const approvedNew = target.replace('original', 'permission-hook');
    const request = hooks((event, input) =>
      event === 'PermissionRequest'
        ? {
            hookSpecificOutput: {
              decision: {
                behavior: 'allow',
                updatedInput: {
                  ...(input['tool_input'] as Record<string, unknown>),
                  new_string: approvedNew,
                },
              },
            },
          }
        : {},
    );
    expect((await scheduler().run(wire)).status).toBe('success');
    const permission = request.mock.calls.find(
      ([call]) => call.eventName === 'PermissionRequest',
    );
    expect(permission?.[0].input['tool_input']).toEqual({
      file_path: file,
      old_string: target,
      new_string: next,
    });
    expect(readFileSync(file, 'utf8')).toBe(
      source.replace(target, approvedNew),
    );
  });

  it('withholds current content when equivalent read permission is denied', async () => {
    await read.build({ file_path: file }).execute(signal());
    vi.spyOn(config, 'getPermissionsDeny').mockReturnValue([
      'Read(fixture.txt)',
    ]);
    const manager = new PermissionManager(config);
    manager.initialize();
    vi.spyOn(config, 'getPermissionManager').mockReturnValue(manager);
    const result = await edit
      .build({
        file_path: file,
        old_string: target.replace('original', 'orignal'),
        new_string: next,
      })
      .execute(signal());
    expect(result.error?.type).toBe('edit_no_occurrence_found');
    expect(strings(result.llmContent).join('\n')).not.toContain(target);
    expect(strings(result.llmContent).join('\n')).not.toMatch(
      /recovery_id\s*:/,
    );
    expect(readFileSync(file, 'utf8')).toBe(source);
  });

  it('does not give a new invocation permission inherited from reference issuance', async () => {
    const { failed, wire } = await recovery();
    syncEditReferenceDelivery(config, strings(failed.llmContent));
    const manager = new PermissionManager({
      getPermissionsDeny: () => ['Edit(fixture.txt)'],
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => [],
      getProjectRoot: () => directory,
      getCwd: () => directory,
    });
    manager.initialize();
    expect(
      manager.findMatchingDenyRule({ toolName: 'edit', filePath: file }),
    ).toBe('Edit(fixture.txt)');
    vi.spyOn(config, 'getPermissionManager').mockReturnValue(manager);
    const call = await scheduler().run(wire);
    expect(call.status).toBe('error');
    expect(strings(call.response.responseParts).join('\n')).toMatch(
      /denied|declined|blocked/i,
    );
    expect(readFileSync(file, 'utf8')).toBe(source);
  });

  it('preserves confirmation-time recovery and shows a real diff before approval', async () => {
    await read.build({ file_path: file }).execute(signal());
    config.setApprovalMode(ApprovalMode.DEFAULT);
    const harness = scheduler();
    const failed = await harness.run({
      file_path: file,
      old_string: target.replace('original', 'orignal'),
      new_string: next,
    });
    expect(failed.status).toBe('error');
    const texts = strings(failed.response.responseParts);
    const result = texts.join('\n');
    expect(result).toContain(target);
    const id = result.match(/recovery_id\s*:\s*"(er_[a-zA-Z0-9-]+)"/)?.[1];
    expect(id).toBeDefined();
    syncEditReferenceDelivery(config, texts);
    await harness.schedule({ file_path: file, recovery_id: id });
    const waiting = harness.waiting();
    expect(waiting?.confirmationDetails.type).toBe('edit');
    if (waiting?.confirmationDetails.type !== 'edit')
      throw new Error('No edit confirmation');
    expect(waiting.confirmationDetails.originalContent).toBe(source);
    expect(waiting.confirmationDetails.newContent).toBe(
      source.replace(target, next),
    );
    expect(waiting.confirmationDetails.fileDiff).toContain(
      "-  const value = 'original';",
    );
    expect(waiting.confirmationDetails.fileDiff).toContain(
      "+  const value = 'changed';",
    );
    expect(readFileSync(file, 'utf8')).toBe(source);
    await waiting.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect((await harness.settled()).status).toBe('success');
    expect(readFileSync(file, 'utf8')).toBe(source.replace(target, next));
  });

  it('rejects a reference if the file changes while the real confirmation waits', async () => {
    const { failed, wire } = await recovery();
    syncEditReferenceDelivery(config, strings(failed.llmContent));
    config.setApprovalMode(ApprovalMode.DEFAULT);
    const harness = scheduler();
    await harness.schedule(wire);
    const waiting = harness.waiting();
    expect(waiting).toBeDefined();
    const changed = `${source}concurrent change\n`;
    writeFileSync(file, changed);
    await waiting!.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect((await harness.settled()).status).toBe('error');
    expect(readFileSync(file, 'utf8')).toBe(changed);
  });

  it.each(['replace', 'truncate', 'fast-compaction'] as const)(
    'invalidates delivered evidence after history %s',
    async (operation) => {
      const { failed, wire } = await recovery();
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'request' }] },
        {
          role: 'model',
          parts: [
            { text: 'temporary reasoning '.repeat(300), thought: true },
            { text: 'answer' },
          ],
        },
      ];
      const chat = new LlmChat(config, {}, history);
      syncEditReferenceDelivery(config, strings(failed.llmContent));
      expect(() => normalizeEditReference(config, wire)).not.toThrow();
      if (operation === 'replace')
        chat.setHistory([{ role: 'user', parts: [{ text: 'summary' }] }]);
      else if (operation === 'truncate') chat.truncateHistory(0);
      else {
        const compacted = chat.compressFast().info;
        expect(compacted.newTokenCount).toBeLessThan(
          compacted.originalTokenCount,
        );
      }
      expect(() => normalizeEditReference(config, wire)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(source);
    },
  );

  it('does not issue a writable read reference for an oversized raw line', async () => {
    writeFileSync(file, `${'x'.repeat(20_000)}\n`);
    const result = await read.build({ file_path: file }).execute(signal());
    expect(strings(result.llmContent).join('\n')).not.toMatch(/read_id\s*:/);
  });
});
