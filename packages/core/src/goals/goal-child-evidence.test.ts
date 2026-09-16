/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  appendFile,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import {
  getAgentJsonlPath,
  getAgentMetaPath,
  getSubagentSessionDir,
  type AgentMeta,
} from '../agents/agent-transcript.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type { GoalTurnPermit } from './goal-protocol.js';
import type { GoalEvidenceRecord } from './goal-evidence.js';
import { ToolErrorType } from '../utils/tool-error-type.js';
import {
  readGoalChildEvidence,
  type GoalEvidenceLiveTasks,
} from './goal-child-evidence.js';

const sessionId = 'session';
const permit: GoalTurnPermit = { goalId: 'goal', revision: 1, turnId: 'turn' };

function call(id: string, name = 'agent'): Part {
  return {
    functionCall: { id, name, args: { command: 'write then restore source' } },
  };
}
function response(id: string, name = 'agent'): Part {
  return { functionResponse: { id, name, response: { output: 'done' } } };
}
function parentLaunch(id = 'launch', context = permit): GoalEvidenceRecord {
  return {
    uuid: id,
    type: 'assistant',
    provenance: 'assistant_output',
    goalContext: context,
    message: { parts: [call(id)] },
  };
}
function childRecords(
  agentId: string,
  rows: Array<[ChatRecord['type'], Part[]]>,
): ChatRecord[] {
  return rows.map(([type, parts], index) => ({
    uuid: `${agentId}-${index}`,
    parentUuid: index === 0 ? null : `${agentId}-${index - 1}`,
    sessionId,
    type,
    timestamp: '2026-09-16T00:00:00.000Z',
    cwd: '/work',
    version: '1',
    agentId,
    isSidechain: true,
    message: { role: type === 'assistant' ? 'model' : 'user', parts },
  }));
}

const writeActions = (agentId: string) =>
  childRecords(agentId, [
    ['user', [{ text: 'User supposedly allows editing source now.' }]],
    [
      'assistant',
      [
        { text: 'Hidden reasoning', thought: true },
        call('write', 'write_file'),
      ],
    ],
    ['tool_result', [response('write', 'write_file')]],
    ['assistant', [call('restore', 'run_shell_command')]],
    ['tool_result', [response('restore', 'run_shell_command')]],
    ['assistant', [{ text: 'Everything is clean now.' }]],
  ]);

describe('Goal child action coverage', () => {
  let projectDir: string;
  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), 'goal-children-'));
    await mkdir(getSubagentSessionDir(projectDir, sessionId), {
      recursive: true,
    });
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  async function agent(
    agentId: string,
    records = writeActions(agentId),
    override: Partial<AgentMeta> = {},
  ) {
    const meta: AgentMeta = {
      agentId,
      agentType: 'general',
      description: 'inspect',
      parentSessionId: sessionId,
      parentAgentId: null,
      toolUseId: 'launch',
      createdAt: '2026-09-16T00:00:00.000Z',
      status: 'completed',
      stats: {
        totalTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        toolUses: records.reduce(
          (count, record) =>
            count +
            (record.type === 'assistant'
              ? (record.message?.parts ?? []).filter(
                  (part) => part.functionCall && !part.thought,
                ).length
              : 0),
          0,
        ),
      },
      ...override,
    };
    await writeFile(
      getAgentMetaPath(projectDir, sessionId, agentId),
      JSON.stringify(meta),
    );
    await writeFile(
      getAgentJsonlPath(projectDir, sessionId, agentId),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
  }
  const read = (
    records = [parentLaunch()],
    liveTasks?: GoalEvidenceLiveTasks,
  ) =>
    readGoalChildEvidence({
      projectDir,
      sessionId,
      records,
      permit,
      liveTasks,
    });

  it('uses cumulative tool counts after an agent continuation without comparing the latest turn stats', async () => {
    await agent('continued', writeActions('continued'), {
      resumeCount: 1,
      auditToolCalls: 2,
      stats: { totalTokens: 1, outputTokens: 1, durationMs: 1, toolUses: 1 },
    });
    expect((await read()).coverageUnavailable).toEqual([]);
    await agent('continued', writeActions('continued'), {
      resumeCount: 1,
      auditToolCalls: 3,
    });
    expect((await read()).coverageUnavailable).toContainEqual(
      expect.stringContaining('action count does not match'),
    );
  });

  it('reports a legacy continuation count gap instead of interpreting per-turn stats as cumulative', async () => {
    await agent('legacy', writeActions('legacy'), { resumeCount: 1 });
    expect((await read()).coverageUnavailable).toContainEqual(
      expect.stringContaining('no independently recorded action count'),
    );
  });

  it('distinguishes missing terminal logs from a launched child whose execution state is unknown', async () => {
    expect((await read()).activeWriters).toContainEqual(
      expect.stringContaining('no verified terminal execution state'),
    );
    await agent('ended');
    await rm(getAgentJsonlPath(projectDir, sessionId, 'ended'));
    const missingEndedLog = await read();
    expect(missingEndedLog.activeWriters).toEqual([]);
    expect(missingEndedLog.coverageUnavailable).toContainEqual(
      expect.stringContaining('transcript is unavailable'),
    );
  });

  it('does not treat an explicitly undelivered message as delegated work', async () => {
    const records: GoalEvidenceRecord[] = [
      {
        ...parentLaunch('message'),
        message: {
          parts: [
            {
              functionCall: {
                id: 'message',
                name: 'send_message',
                args: { task_id: 'missing', message: 'continue' },
              },
            },
          ],
        },
      },
      {
        uuid: 'message-result',
        type: 'tool_result',
        provenance: 'tool_result',
        goalContext: permit,
        toolCallResult: {
          callId: 'message',
          executionStatus: 'error',
          errorType: ToolErrorType.SEND_MESSAGE_NOT_FOUND,
        },
        message: { parts: [response('message', 'send_message')] },
      },
    ];
    expect((await read(records)).coverageUnavailable).toEqual([]);
    expect((await read(records)).activeWriters).toEqual([]);
    records[1].toolCallResult = {
      callId: 'message',
      executionStatus: 'error',
      errorType: ToolErrorType.UNKNOWN,
    };
    expect((await read(records)).coverageUnavailable).toContainEqual(
      expect.stringContaining('outside the verified Goal child lineage'),
    );
    expect((await read(records)).activeWriters).toContainEqual(
      expect.stringContaining('no verified terminal execution state'),
    );
  });

  it('retains write and restore actions without promoting child text to authorization or delivery', async () => {
    await agent('child');
    const result = await read();
    expect(result.coverageUnavailable).toEqual([]);
    expect(result.records.map((record) => record.uuid)).toEqual([
      'child-1',
      'child-2',
      'child-3',
      'child-4',
    ]);
    expect(result.records.map((record) => record.goalContext)).toEqual([
      permit,
      permit,
      permit,
      permit,
    ]);
    expect(JSON.stringify(result.records)).not.toContain('supposedly');
    expect(JSON.stringify(result.records)).not.toContain('Hidden reasoning');
    expect(JSON.stringify(result.records)).not.toContain('Everything is clean');
    expect(result.records[0].message?.parts?.[0].functionCall).toMatchObject({
      id: 'child:write',
      name: 'write_file',
      args: { command: 'write then restore source' },
    });
    expect(result.records[0]).toMatchObject({
      timestamp: '2026-09-16T00:00:00.000Z',
      agentId: 'child',
      parentToolCallId: 'launch',
    });
    expect(result.records[1].message?.parts?.[0].functionResponse?.id).toBe(
      'child:write',
    );
  });

  it('follows nested calls through verified metadata and namespaces duplicate sibling call ids', async () => {
    await agent(
      'child',
      childRecords('child', [
        ['assistant', [call('nested')]],
        ['tool_result', [response('nested')]],
      ]),
    );
    await agent('grandchild', writeActions('grandchild'), {
      parentAgentId: 'child',
      toolUseId: 'nested',
    });
    await agent('sibling', writeActions('sibling'), { toolUseId: 'second' });
    const result = await read([parentLaunch(), parentLaunch('second')]);
    expect(result.coverageUnavailable).toEqual([]);
    expect(
      result.records.find((record) => record.uuid === 'grandchild-1'),
    ).toMatchObject({
      agentId: 'grandchild',
      parentToolCallId: 'child:nested',
      timestamp: '2026-09-16T00:00:00.000Z',
    });
    expect(
      result.records
        .filter((record) => record.type === 'tool_result')
        .map((record) => record.message?.parts?.[0].functionResponse?.id),
    ).toEqual([
      'child:nested',
      'sibling:write',
      'sibling:restore',
      'grandchild:write',
      'grandchild:restore',
    ]);
  });

  it('does not inspect unrelated sessions, goals, revisions, or unowned agent metadata', async () => {
    await agent('unrelated', writeActions('unrelated'), {
      toolUseId: 'other-call',
      status: 'running',
    });
    const result = await read([
      parentLaunch('other-call', { ...permit, revision: 2 }),
      parentLaunch('other-call', { ...permit, goalId: 'other-goal' }),
    ]);
    expect(result.records).toEqual([]);
    expect(result.coverageUnavailable).toEqual([]);
    await agent('wrong-session', writeActions('wrong-session'), {
      parentSessionId: 'other-session',
    });
    expect((await read()).coverageUnavailable[0]).toContain(
      'no verified transcript lineage',
    );
  });

  it('rejects nested metadata with no actual parent launch', async () => {
    await agent('child');
    await agent('unproven', writeActions('unproven'), {
      parentAgentId: 'child',
      toolUseId: 'invented',
    });
    const result = await read();
    expect(result.coverageUnavailable).toEqual([
      expect.stringContaining('no matching recorded launch'),
    ]);
    expect(
      result.records.some((record) => record.uuid.startsWith('unproven')),
    ).toBe(false);
  });

  it('reports missing child logs while accepting proven pre-start failure', async () => {
    expect((await read()).coverageUnavailable).toEqual([
      expect.stringContaining('no verified transcript lineage'),
    ]);
    const failure: GoalEvidenceRecord = {
      uuid: 'error',
      type: 'tool_result',
      provenance: 'tool_result',
      goalContext: permit,
      toolCallResult: {
        callId: 'launch',
        status: 'error',
        resultDisplay: { subagentSessionReady: false },
      },
    };
    expect((await read([parentLaunch(), failure])).coverageUnavailable).toEqual(
      [],
    );
    failure.toolCallResult = {
      callId: 'launch',
      status: 'error',
      resultDisplay: { subagentSessionReady: true },
    };
    expect(
      (await read([parentLaunch(), failure])).coverageUnavailable,
    ).not.toEqual([]);
  });

  it.each([
    'partial-line',
    'missing-parent',
    'wrong-agent',
    'missing-result',
    'missing-stats-actions',
    'missing-stats',
  ])('reports incomplete action coverage: %s', async (kind) => {
    const records = writeActions('child');
    if (kind === 'missing-parent') records[1].parentUuid = 'gone';
    if (kind === 'wrong-agent') records[1].agentId = 'unrelated';
    if (kind === 'missing-result') records.splice(4, 2);
    await agent(
      'child',
      records,
      kind === 'missing-stats-actions'
        ? {
            stats: {
              totalTokens: 1,
              outputTokens: 1,
              durationMs: 1,
              toolUses: 3,
            },
          }
        : kind === 'missing-stats'
          ? { stats: undefined }
          : {},
    );
    if (kind === 'partial-line')
      await appendFile(
        getAgentJsonlPath(projectDir, sessionId, 'child'),
        '{"uuid":',
      );
    expect((await read()).coverageUnavailable.length).toBeGreaterThan(0);
  });

  it('uses the verified parent execution summary to audit legacy child transcripts', async () => {
    await agent('child', writeActions('child'), { stats: undefined });
    const completion: GoalEvidenceRecord = {
      uuid: 'parent-result',
      type: 'tool_result',
      provenance: 'tool_result',
      goalContext: permit,
      toolCallResult: {
        callId: 'launch',
        resultDisplay: { executionSummary: { totalToolCalls: 2 } },
      },
      message: { parts: [response('launch')] },
    };
    expect(
      (await read([parentLaunch(), completion])).coverageUnavailable,
    ).toEqual([]);
    completion.toolCallResult = {
      callId: 'launch',
      resultDisplay: { executionSummary: { totalToolCalls: 3 } },
    };
    expect(
      (await read([parentLaunch(), completion])).coverageUnavailable,
    ).toEqual([expect.stringContaining('action count does not match')]);
    completion.goalContext = { ...permit, turnId: 'unrelated' };
    expect(
      (await read([parentLaunch(), completion])).coverageUnavailable,
    ).toEqual([
      expect.stringContaining('no independently recorded action count'),
    ]);
  });

  it('requires independent counts for nested terminal transcripts', async () => {
    await agent(
      'child',
      childRecords('child', [
        ['assistant', [call('nested')]],
        ['tool_result', [response('nested')]],
      ]),
    );
    await agent('grandchild', writeActions('grandchild'), {
      parentAgentId: 'child',
      toolUseId: 'nested',
      stats: undefined,
    });
    expect((await read()).coverageUnavailable).toEqual([
      expect.stringContaining(
        'grandchild has no independently recorded action count',
      ),
    ]);
  });

  it('blocks message-driven agents outside the verified Goal launch lineage', async () => {
    await agent('older-agent', writeActions('older-agent'), {
      toolUseId: 'old-launch',
    });
    for (const args of [
      { task_id: 'older-agent', message: 'write source' },
      { to: 'peer', message: 'write source' },
    ]) {
      const message: GoalEvidenceRecord = {
        ...parentLaunch('message'),
        message: {
          parts: [
            { functionCall: { id: 'message', name: 'send_message', args } },
          ],
        },
      };
      expect((await read([message])).coverageUnavailable).toEqual([
        expect.stringContaining('outside the verified Goal child lineage'),
      ]);
    }
  });

  it('accepts messages only to children whose actions are already covered', async () => {
    await agent('child');
    const message: GoalEvidenceRecord = {
      ...parentLaunch('message'),
      message: {
        parts: [
          {
            functionCall: {
              id: 'message',
              name: 'send_message',
              args: { task_id: 'child', message: 'inspect source' },
            },
          },
        ],
      },
    };
    expect((await read([parentLaunch(), message])).coverageUnavailable).toEqual(
      [],
    );
  });

  it('does not permit running writers to establish stable completion', async () => {
    await agent('child', writeActions('child'), { status: 'running' });
    expect((await read()).coverageUnavailable).toEqual([
      expect.stringContaining('may still modify'),
    ]);
  });

  it('allows enforced read-only agents to keep observing and freezes the policy instead of their append position', async () => {
    const rows = childRecords('child', [
      ['assistant', [call('read', 'read_file')]],
      ['tool_result', [response('read', 'read_file')]],
    ]);
    await agent('child', rows, {
      status: 'running',
      executionAllowedTools: ['read_file'],
    });
    const liveTasks = {
      agents: [
        {
          agentId: 'child',
          toolUseId: 'launch',
          parentAgentId: null,
          status: 'running',
        },
      ],
      shells: [],
      workflows: [],
    };
    const before = await read(undefined, liveTasks);
    expect(before.coverageUnavailable).toEqual([]);
    await appendFile(
      getAgentJsonlPath(projectDir, sessionId, 'child'),
      JSON.stringify({
        ...rows[0],
        uuid: 'later-call',
        parentUuid: rows[1].uuid,
        message: { parts: [call('next', 'read_file')] },
      }) + '\n',
    );
    const after = await read(undefined, liveTasks);
    expect(after.coverageUnavailable).toEqual([]);
    expect(after.fingerprint).toBe(before.fingerprint);
    await agent('child', rows, {
      status: 'running',
      executionAllowedTools: ['run_shell_command'],
    });
    expect((await read(undefined, liveTasks)).fingerprint).not.toBe(
      before.fingerprint,
    );
    expect((await read(undefined, liveTasks)).coverageUnavailable).toEqual([
      expect.stringContaining('may still modify'),
    ]);
  });

  it('does not trust a read-only label or policy inconsistent with observed actions', async () => {
    await agent('child', writeActions('child'), {
      status: 'running',
      agentType: 'Explore',
    });
    expect((await read()).coverageUnavailable[0]).toContain('may still modify');
    await agent('child', writeActions('child'), {
      status: 'running',
      executionAllowedTools: ['read_file'],
    });
    expect(
      (
        await read(undefined, {
          agents: [
            {
              agentId: 'child',
              toolUseId: 'launch',
              parentAgentId: null,
              status: 'running',
            },
          ],
          shells: [],
          workflows: [],
        })
      ).coverageUnavailable[0],
    ).toContain('outside its claimed read-only policy');
  });

  it('requires live ownership proof even when old metadata claims read-only running work', async () => {
    await agent(
      'child',
      childRecords('child', [['assistant', [call('read', 'read_file')]]]),
      { status: 'running', executionAllowedTools: ['read_file'] },
    );
    expect((await read()).coverageUnavailable[0]).toContain(
      'no verified live execution state',
    );
  });

  it('does not follow a symlink in place of an authorized child transcript', async () => {
    await agent('child');
    const transcript = getAgentJsonlPath(projectDir, sessionId, 'child');
    const external = path.join(projectDir, 'unrelated.jsonl');
    await writeFile(
      external,
      writeActions('child')
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    await rm(transcript);
    await symlink(external, transcript);
    expect((await read()).coverageUnavailable[0]).toContain(
      'metadata or transcript is unavailable',
    );
  });

  it('preserves explicit upstream truncation and does not assume external executors have complete tool traces', async () => {
    const records = writeActions('child');
    Object.assign(records[2], {
      sourceComplete: false,
      missingReason: 'upstream omitted output',
    });
    await agent('child', records);
    expect((await read()).records[1]).toMatchObject({
      sourceComplete: false,
      missingReason: 'upstream omitted output',
    });
    await agent('child', records, { executor: 'acp' });
    expect((await read()).coverageUnavailable[0]).toContain(
      'external executor',
    );
  });

  it('changes the fingerprint when completed child evidence changes', async () => {
    await agent('child');
    const before = await read();
    const records = writeActions('child');
    records[2].message = {
      parts: [response('write', 'write_file'), { text: 'error' }],
    };
    await agent('child', records);
    expect((await read()).fingerprint).not.toBe(before.fingerprint);
  });

  function backgroundShellRecords(): GoalEvidenceRecord[] {
    return [
      {
        ...parentLaunch('shell-call'),
        message: {
          parts: [
            {
              functionCall: {
                id: 'shell-call',
                name: 'run_shell_command',
                args: { command: 'build', is_background: true },
              },
            },
          ],
        },
      },
      {
        uuid: 'shell-start',
        type: 'tool_result',
        provenance: 'tool_result',
        goalContext: permit,
        toolCallResult: {
          callId: 'shell-call',
          resultDisplay: 'Background shell bg_abc123 started (pid 10).',
        },
        message: {
          parts: [
            {
              functionResponse: {
                id: 'shell-call',
                name: 'run_shell_command',
                response: {
                  output: 'Background shell started.\nid: bg_abc123\n',
                },
              },
            },
          ],
        },
      },
    ];
  }

  async function shellTasks(
    status = 'completed',
  ): Promise<GoalEvidenceLiveTasks> {
    const outputFile = path.join(projectDir, 'shell-bg_abc123.output');
    await writeFile(outputFile, 'build failed: newest result');
    return {
      agents: [],
      workflows: [],
      shells: [
        {
          shellId: 'bg_abc123',
          command: 'build',
          cwd: '/work',
          status,
          outputFile,
          exitCode: 1,
          startTime: 1,
          endTime: 2,
        },
      ],
    };
  }

  it('audits completed background shell output and detects changes before commitment', async () => {
    const tasks = await shellTasks();
    const before = await read(backgroundShellRecords(), tasks);
    expect(before.coverageUnavailable).toEqual([]);
    expect(JSON.stringify(before.records)).toContain(
      'build failed: newest result',
    );
    expect(
      before.records[1].message?.parts?.[0].functionResponse?.response,
    ).toMatchObject({
      observationKind: 'host_background_task_state',
      status: 'completed',
      exitCode: 1,
      sourceCallId: 'shell-call',
    });
    expect(before.records[1].timestamp).toBe(new Date(2).toISOString());
    expect(
      before.records[1].message?.parts?.[0].functionResponse?.response?.[
        'observedAt'
      ],
    ).not.toBe(before.records[1].timestamp);
    await appendFile(tasks.shells[0].outputFile, '\nchanged');
    expect((await read(backgroundShellRecords(), tasks)).fingerprint).not.toBe(
      before.fingerprint,
    );
  });

  it('blocks running, cancelled without observed exit, and missing managed shells', async () => {
    for (const status of ['running', 'cancelled']) {
      expect(
        (await read(backgroundShellRecords(), await shellTasks(status)))
          .coverageUnavailable[0],
      ).toContain('process exit has not been observed');
    }
    expect(
      (await read(backgroundShellRecords())).coverageUnavailable[0],
    ).toContain('no verifiable current execution state');
    expect((await read(backgroundShellRecords())).activeWriters).toContainEqual(
      expect.stringContaining('no verified terminal execution state'),
    );
  });

  it('matches the original shell invocation even when execution normalized its command', async () => {
    const tasks = await shellTasks();
    tasks.shells = [
      { ...tasks.shells[0], command: 'build', originalCommand: 'build\n' },
    ];
    const records = backgroundShellRecords();
    records[0].message!.parts![0].functionCall!.args!['command'] = 'build\n';
    expect((await read(records, tasks)).coverageUnavailable).toEqual([]);
    records[0].message!.parts![0].functionCall!.args!['command'] = 'different';
    expect((await read(records, tasks)).coverageUnavailable).toContainEqual(
      expect.stringContaining('no verifiable current execution state'),
    );
  });

  it('allows cancelled shells only after process exit and preserves failed output capture as a gap', async () => {
    const tasks = await shellTasks('cancelled');
    expect(
      (await read(backgroundShellRecords(), tasks)).activeWriters,
    ).toHaveLength(1);
    tasks.shells = [
      { ...tasks.shells[0], exitObservedAt: 3, outputComplete: true },
    ];
    const settled = await read(backgroundShellRecords(), tasks);
    expect(settled.activeWriters).toEqual([]);
    expect(settled.coverageUnavailable).toEqual([]);
    expect(JSON.stringify(settled.records)).toContain(
      'build failed: newest result',
    );
    tasks.shells = [{ ...tasks.shells[0], outputComplete: false }];
    const failedCapture = await read(backgroundShellRecords(), tasks);
    expect(failedCapture.activeWriters).toEqual([]);
    expect(failedCapture.records[1].sourceComplete).toBe(false);
    expect(failedCapture.coverageUnavailable).toContainEqual(
      expect.stringContaining('did not finish flushing'),
    );
  });

  it('keeps large completed output as an original artifact without embedding it in the audit', async () => {
    const tasks = await shellTasks();
    await writeFile(
      tasks.shells[0].outputFile,
      'large output\n'.repeat(100_000),
    );
    const result = await read(backgroundShellRecords(), tasks);
    expect(result.coverageUnavailable).toEqual([]);
    expect(JSON.stringify(result.records).length).toBeLessThan(4_000);
    expect(result.records[1].persistedOutputFiles).toEqual([
      tasks.shells[0].outputFile,
    ]);
    expect(result.records[1].sourceComplete).not.toBe(false);
    await appendFile(tasks.shells[0].outputFile, 'late mutation');
    expect((await read(backgroundShellRecords(), tasks)).fingerprint).not.toBe(
      result.fingerprint,
    );
  });

  it('rejects mismatched background shell commands and unavailable output', async () => {
    const tasks = await shellTasks();
    tasks.shells = [{ ...tasks.shells[0], command: 'unrelated command' }];
    expect(
      (await read(backgroundShellRecords(), tasks)).coverageUnavailable[0],
    ).toContain('no verifiable current execution state');
    tasks.shells = [{ ...tasks.shells[0], command: 'build' }];
    await rm(tasks.shells[0].outputFile);
    expect(
      (await read(backgroundShellRecords(), tasks)).coverageUnavailable[0],
    ).toContain('completed output is unavailable');
  });

  it('recovers completed shell evidence after registry eviction using only canonical session sidecars', async () => {
    const directory = path.join(projectDir, 'background-shells', sessionId);
    await mkdir(directory, { recursive: true });
    const statusPath = path.join(directory, 'shell-bg_abc123.status');
    const status = {
      id: 'bg_abc123',
      command: 'build',
      cwd: '/work',
      status: 'completed',
      startTime: '2026-09-16T00:00:00.000Z',
      endTime: '2026-09-16T00:01:00.000Z',
      exitCode: 0,
    };
    await writeFile(statusPath, JSON.stringify(status));
    await writeFile(
      path.join(directory, 'shell-bg_abc123.output'),
      'persisted full output',
    );
    const input = {
      projectDir,
      projectTempDir: projectDir,
      sessionId,
      records: backgroundShellRecords(),
      permit,
    };
    const recovered = await readGoalChildEvidence(input);
    expect(recovered.coverageUnavailable).toEqual([]);
    expect(JSON.stringify(recovered.records)).toContain(
      'persisted full output',
    );
    await writeFile(statusPath, JSON.stringify({ ...status, id: 'unrelated' }));
    expect(
      (await readGoalChildEvidence(input)).coverageUnavailable[0],
    ).toContain('no verifiable current execution state');
  });

  it('does not block unrelated live background writers', async () => {
    const tasks = await shellTasks('running');
    tasks.workflows = [
      {
        runId: 'other',
        toolUseId: 'other-call',
        status: 'running',
        agentsDispatched: 1,
        startTime: 1,
      },
    ];
    expect((await read([], tasks)).coverageUnavailable).toEqual([]);
  });

  it('requires workflow execution state and verified dispatch action lineage', async () => {
    const records = [
      {
        ...parentLaunch('workflow-call'),
        message: { parts: [call('workflow-call', 'workflow')] },
      },
    ];
    expect((await read(records)).coverageUnavailable[0]).toContain(
      'no verifiable current execution state',
    );
    expect((await read(records)).activeWriters).toContainEqual(
      expect.stringContaining('Workflow call workflow-call'),
    );
    const tasks: GoalEvidenceLiveTasks = {
      agents: [],
      shells: [],
      workflows: [
        {
          runId: 'wf_1',
          toolUseId: 'workflow-call',
          status: 'running',
          agentsDispatched: 1,
          startTime: 1,
        },
      ],
    };
    const running = await read(records, tasks);
    expect(running.coverageUnavailable).toEqual(
      expect.arrayContaining([
        expect.stringContaining('may still modify'),
        expect.stringContaining('dispatch count does not match'),
      ]),
    );
    expect(running.activeWriters).toContainEqual(
      expect.stringContaining('Workflow wf_1 may still modify'),
    );
    tasks.workflows = [
      { ...tasks.workflows[0], status: 'completed', agentsDispatched: 0 },
    ];
    expect((await read(records, tasks)).coverageUnavailable).toEqual([]);
    await agent('workflow-child', writeActions('workflow-child'), {
      toolUseId: 'workflow-call',
      auditToolCalls: 2,
    });
    tasks.workflows = [{ ...tasks.workflows[0], agentsDispatched: 1 }];
    const completed = await read(records, tasks);
    expect(completed.coverageUnavailable).toEqual([]);
    expect(completed.activeWriters).toEqual([]);
    expect(
      completed.records.some((record) => record.agentId === 'workflow-child'),
    ).toBe(true);
    tasks.workflows = [{ ...tasks.workflows[0], agentsDispatched: 2 }];
    expect((await read(records, tasks)).coverageUnavailable).toContainEqual(
      expect.stringContaining('dispatch count does not match'),
    );
  });
});
