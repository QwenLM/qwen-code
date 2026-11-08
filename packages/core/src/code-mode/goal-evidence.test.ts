/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { executeToolCall } from '../core/nonInteractiveToolExecutor.js';
import type { ToolCallRequestInfo } from '../core/turn.js';
import { buildGoalVerifierEvidenceWindow } from '../goals/goal-evidence.js';
import { createGoalRuntime, type GoalRuntime } from '../goals/goal-runtime.js';
import { GetGoalTool } from '../goals/goal-tools.js';
import { goalToolResultProvenance } from '../goals/goal-tool-result-provenance.js';
import { ChatRecordingService } from '../services/chatRecordingService.js';
import { buildApiHistoryFromConversation } from '../services/session-api-history.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { validateTranscriptRecord } from '../utils/transcript-records.js';
import { ExecTool } from '../tools/exec.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ToolRegistry } from '../tools/tool-registry.js';

let workspace: string;
let config: Config;
let recorder: ChatRecordingService;
let runtime: GoalRuntime;

afterEach(async () => {
  runtime?.dispose();
  await recorder?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Code Mode Goal evidence', () => {
  it.each([true, false])(
    'preserves original facts and computation when outer recording is deferred=%s',
    async (deferOuter) => {
      workspace = await mkdtemp(path.join(os.tmpdir(), 'goal-exec-evidence-'));
      config = makeFakeConfig({
        targetDir: workspace,
        cwd: workspace,
        sessionId: randomUUID(),
        codeModeOnly: true,
        chatRecording: false,
        telemetry: { enabled: false },
        deferTelemetryInitialization: true,
      });
      vi.spyOn(Storage.prototype, 'getProjectDir').mockReturnValue(workspace);
      recorder = new ChatRecordingService(config, undefined, false);
      runtime = createGoalRuntime({ journal: recorder });
      vi.spyOn(config, 'getChatRecordingService').mockReturnValue(recorder);
      vi.spyOn(config, 'getGoalRuntime').mockReturnValue(runtime);
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new ReadFileTool(config));
      registry.registerTool(new GetGoalTool(config));
      const file = path.join(workspace, 'fact.txt');
      await writeFile(file, 'ORIGINAL_FILE_FACT\n');
      await runtime.dispatch({
        action: 'create',
        objective: 'Read the fixture',
      });
      const permit = runtime.beginTurn('code-turn')!;
      const goal = runtime.getSnapshot().goal!;
      const request: ToolCallRequestInfo = {
        callId: 'exec-evidence',
        name: 'exec',
        args: {
          source: `
            const goal = await tools.get_goal({});
            text(goal.output);
            await tools.read_file({file_path: ${JSON.stringify(file)}});
            try {
              await tools.read_file({file_path: ${JSON.stringify(path.join(workspace, 'missing.txt'))}});
            } catch {}
            text("Claim: fixture overwritten and 999 tests passed.");
            text(6 * 7);
          `,
        },
        isClientInitiated: false,
        prompt_id: 'code-prompt',
        goalContext: permit,
      };
      recorder.recordAssistantTurn({
        model: 'test-model',
        message: [
          {
            functionCall: {
              id: request.callId,
              name: request.name,
              args: request.args,
            },
          },
        ],
        goalContext: permit,
      });
      const response = await executeToolCall(
        config,
        request,
        new AbortController().signal,
        { recordToolResult: !deferOuter },
      );
      expect(response.error).toBeUndefined();
      if (deferOuter) {
        recorder.recordToolResult(
          response.responseParts,
          { ...response, status: 'success' },
          goalToolResultProvenance(request),
        );
      }
      const records = await recorder.readActiveTranscriptChain();
      expect(
        records.flatMap((record) =>
          validateTranscriptRecord(record).diagnostics.filter(
            (diagnostic) => diagnostic.affectsCompleteness,
          ),
        ),
      ).toEqual([]);
      const results = records.filter((record) => record.type === 'tool_result');
      const nested = results.filter(
        (record) => record.toolCallResult?.callId !== request.callId,
      );
      expect(nested).toHaveLength(3);
      expect(
        nested.every((record) => record.subtype === 'code_mode_tool_result'),
      ).toBe(true);
      expect(
        nested.every(
          (record) =>
            JSON.stringify(record.goalContext) === JSON.stringify(permit),
        ),
      ).toBe(true);
      expect(
        results.filter(
          (record) => record.toolCallResult?.callId === request.callId,
        ),
      ).toHaveLength(1);
      const window = buildGoalVerifierEvidenceWindow(
        { records, goal, permit },
        { budgetBytes: 256_000 },
      );
      const facts = window.evidence.filter(
        (entry) => entry.proofKind === 'external_fact',
      );
      expect(facts).toHaveLength(2);
      expect(
        facts.some((entry) => entry.content.includes('ORIGINAL_FILE_FACT')),
      ).toBe(true);
      expect(facts.some((entry) => entry.content.includes('missing.txt'))).toBe(
        true,
      );
      expect(facts.some((entry) => entry.content.includes('999 tests'))).toBe(
        false,
      );
      const bookkeeping = nested.find(
        (record) => record.provenance === 'goal_runtime',
      )!;
      expect(bookkeeping).toBeDefined();
      expect(window.evidence.map((entry) => entry.uuid)).not.toContain(
        bookkeeping.uuid,
      );
      const outer = results.find(
        (record) => record.toolCallResult?.callId === request.callId,
      )!;
      expect(
        window.evidence.find((entry) => entry.uuid === outer.uuid),
      ).toMatchObject({
        proofKind: 'execution_output',
        content: expect.stringContaining('42'),
      });
      const legacy = records.map((record) =>
        record.uuid === outer.uuid
          ? { ...record, provenance: undefined }
          : record,
      );
      expect(
        buildGoalVerifierEvidenceWindow(
          { records: legacy, goal, permit },
          { budgetBytes: 256_000 },
        ).evidence.find((entry) => entry.uuid === outer.uuid)?.proofKind,
      ).toBe('execution_output');
      const history = buildApiHistoryFromConversation({ messages: records });
      expect(
        history
          .flatMap((content) => content.parts ?? [])
          .filter((part) => part.functionResponse)
          .map((part) => part.functionResponse?.id),
      ).toEqual([request.callId]);
    },
    15_000,
  );
});
