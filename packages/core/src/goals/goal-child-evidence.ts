/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Part } from '@google/genai';
import {
  getAgentJsonlPath,
  getAgentMetaPath,
  readAgentTrace,
  type AgentMeta,
  type AgentTraceNode,
} from '../agents/agent-transcript.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolErrorType } from '../utils/tool-error-type.js';
import { openNoFollow } from '../utils/no-follow-open.js';
import type { GoalEvidenceRecord } from './goal-evidence.js';
import type { GoalTurnPermit } from './goal-protocol.js';

export interface GoalChildEvidence {
  records: GoalEvidenceRecord[];
  coverageUnavailable: string[];
  fingerprint: string;
  activeWriters?: string[];
}

export interface GoalEvidenceLiveTasks {
  agents: ReadonlyArray<{
    agentId: string;
    toolUseId?: string;
    parentAgentId?: string | null;
    status: string;
  }>;
  shells: ReadonlyArray<{
    shellId: string;
    command: string;
    originalCommand?: string;
    exitObservedAt?: number;
    outputComplete?: boolean;
    cwd: string;
    status: string;
    outputFile: string;
    exitCode?: number;
    startTime: number;
    endTime?: number;
  }>;
  workflows: ReadonlyArray<{
    runId: string;
    toolUseId?: string;
    status: string;
    agentsDispatched: number;
    startTime: number;
    endTime?: number;
  }>;
}

interface ChildLaunch {
  callId: string;
  toolName: string;
  permit: GoalTurnPermit;
  parentAgentId: string | null;
  records: readonly GoalEvidenceRecord[];
}

const READ_ONLY_TOOLS = new Set<string>([
  ToolNames.READ_FILE,
  ToolNames.GREP,
  ToolNames.GLOB,
  ToolNames.LS,
  ToolNames.ZOOM_IMAGE,
]);
const LAUNCH_TOOLS = new Set<string>([ToolNames.AGENT, ToolNames.WORKFLOW]);
const MAX_RECORDED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_SHELL_OUTPUT_BYTES = 64 * 1024;

export async function readGoalChildEvidence(input: {
  projectDir: string;
  projectTempDir?: string;
  sessionId: string;
  records: readonly GoalEvidenceRecord[];
  permit: GoalTurnPermit;
  liveTasks?: GoalEvidenceLiveTasks;
}): Promise<GoalChildEvidence> {
  const result: GoalChildEvidence = {
    records: [],
    coverageUnavailable: [],
    fingerprint: '',
    activeWriters: [],
  };
  const stamp = createHash('sha256');
  const unavailable = (reason: string) => {
    result.coverageUnavailable.push(reason);
    stamp.update(reason);
  };
  const launches = findLaunches(input.records, input.permit, null);
  const visited = new Set<string>();
  const messagedAgents = new Set<string | undefined>();
  const checkMessageCoverage = () => {
    if (
      [...messagedAgents].some((agentId) => !agentId || !visited.has(agentId))
    ) {
      unavailable(
        'send_message delegated work outside the verified Goal child lineage; action coverage is unavailable.',
      );
      if (
        [...messagedAgents].some(
          (agentId) =>
            (!agentId || !visited.has(agentId)) &&
            !input.liveTasks?.agents.some(
              (task) =>
                task.agentId === agentId &&
                ['completed', 'failed'].includes(task.status),
            ),
        )
      ) {
        (result.activeWriters ??= []).push(
          'A message recipient has no verified terminal execution state.',
        );
      }
    }
  };
  const backgroundDir =
    input.projectTempDir && /^[a-zA-Z0-9_-]+$/.test(input.sessionId)
      ? path.join(input.projectTempDir, 'background-shells', input.sessionId)
      : undefined;
  await readBackgroundActions(
    input.records,
    input.permit,
    input.liveTasks,
    result,
    (value) => stamp.update(value),
    unavailable,
    messagedAgents,
    backgroundDir,
  );
  if (launches.length === 0) {
    checkMessageCoverage();
    result.fingerprint = stamp.digest('hex');
    return result;
  }
  let nodes: AgentTraceNode[];
  try {
    nodes = (await readAgentTrace(input.projectDir, input.sessionId)).nodes;
  } catch {
    unavailable('Child agent metadata could not be read.');
    (result.activeWriters ??= []).push(
      'Launched child agents have no verified terminal execution state.',
    );
    result.fingerprint = stamp.digest('hex');
    return result;
  }
  for (let index = 0; index < launches.length; index++) {
    const launch = launches[index]!;
    const matching = nodes.filter(
      (node) =>
        node.toolUseId === launch.callId &&
        node.parentAgentId === launch.parentAgentId &&
        node.lineageState === 'complete',
    );
    if (launch.toolName === ToolNames.WORKFLOW) {
      const workflow = input.liveTasks?.workflows.find(
        (task) => task.toolUseId === launch.callId,
      );
      if (workflow && workflow.agentsDispatched !== matching.length) {
        unavailable(
          `Workflow ${workflow.runId} dispatch count does not match its verified child launch lineage.`,
        );
      }
      if (workflow?.agentsDispatched === 0 && matching.length === 0) continue;
    }
    if (matching.length === 0) {
      if (!didNotStart(launch)) {
        if (
          launch.toolName !== ToolNames.WORKFLOW ||
          !input.liveTasks?.workflows.some(
            (task) =>
              task.toolUseId === launch.callId && task.status === 'completed',
          )
        ) {
          (result.activeWriters ??= []).push(
            `Child call ${launch.callId} has no verified terminal execution state.`,
          );
        }
        unavailable(
          `Child action coverage is unavailable for call ${launch.callId}: no verified transcript lineage.`,
        );
      }
      continue;
    }
    for (const node of matching) {
      if (visited.has(node.agentId)) {
        unavailable(
          `Child agent ${node.agentId} has ambiguous launch ownership.`,
        );
        continue;
      }
      visited.add(node.agentId);
      if (!/^[a-zA-Z0-9_-]+$/.test(node.agentId)) {
        unavailable('Child agent metadata contains an invalid agent identity.');
        continue;
      }
      let meta: AgentMeta;
      let raw: string;
      let verifiedTerminal = false;
      try {
        meta = JSON.parse(
          await readRecordedFile(
            getAgentMetaPath(input.projectDir, input.sessionId, node.agentId),
          ),
        ) as AgentMeta;
        if (!matchesNode(meta, node, input.sessionId)) {
          throw new Error('Child metadata changed');
        }
        verifiedTerminal = ['completed', 'failed', 'cancelled'].includes(
          meta.status ?? '',
        );
        raw = await readRecordedFile(
          getAgentJsonlPath(input.projectDir, input.sessionId, node.agentId),
        );
      } catch {
        if (!verifiedTerminal)
          (result.activeWriters ??= []).push(
            `Child agent ${node.agentId} has no verified terminal execution state.`,
          );
        unavailable(
          `Child agent ${node.agentId} metadata or transcript is unavailable.`,
        );
        continue;
      }
      const enforcedReadOnly =
        meta.executor === undefined &&
        Array.isArray(meta.executionAllowedTools) &&
        meta.executionAllowedTools.every((tool) => READ_ONLY_TOOLS.has(tool));
      if (meta.executor !== undefined) {
        unavailable(
          `Child agent ${node.agentId} uses an external executor whose complete action coverage is not established by this transcript.`,
        );
      }
      if (
        meta.stats &&
        (!Number.isSafeInteger(meta.stats.toolUses) || meta.stats.toolUses < 0)
      ) {
        unavailable(
          `Child agent ${node.agentId} has invalid action-count metadata.`,
        );
      }
      const liveAgent = input.liveTasks?.agents.find(
        (agent) => agent.agentId === node.agentId,
      );
      const active =
        liveAgent?.status === 'running' ||
        meta.status === 'running' ||
        meta.status === undefined;
      const verifiedLiveReadOnly =
        active &&
        enforcedReadOnly &&
        liveAgent?.status === 'running' &&
        liveAgent.toolUseId === meta.toolUseId &&
        (liveAgent.parentAgentId ?? null) === meta.parentAgentId;
      if (active && enforcedReadOnly && !verifiedLiveReadOnly) {
        (result.activeWriters ??= []).push(
          `Child agent ${node.agentId} has no verified live execution state.`,
        );
        unavailable(
          `Child agent ${node.agentId} has no verified live execution state.`,
        );
      }
      if (active && !enforcedReadOnly) {
        (result.activeWriters ??= []).push(
          `Child agent ${node.agentId} may still modify the Goal target.`,
        );
        unavailable(
          `Child agent ${node.agentId} may still modify the Goal target; its execution policy does not prove read-only operation.`,
        );
      }
      // An enforced read-only agent can append observations without changing
      // the target. Its immutable execution policy, not its append position,
      // determines whether a frozen audit can still commit.
      stamp.update(
        JSON.stringify(
          verifiedLiveReadOnly
            ? {
                agentId: meta.agentId,
                parentSessionId: meta.parentSessionId,
                parentAgentId: meta.parentAgentId,
                toolUseId: meta.toolUseId,
                createdAt: meta.createdAt,
                executionAllowedTools: meta.executionAllowedTools,
              }
            : { meta, raw },
        ),
      );
      let records: ChatRecord[];
      try {
        records = parseTranscript(raw, node.agentId, input.sessionId);
      } catch {
        unavailable(
          `Child agent ${node.agentId} transcript is missing, partial, or has invalid record lineage.`,
        );
        continue;
      }
      const mapped = mapActions(
        records,
        launch.permit,
        node.agentId,
        verifiedLiveReadOnly,
        launch.parentAgentId
          ? `${launch.parentAgentId}:${launch.callId}`
          : launch.callId,
      );
      if (verifiedLiveReadOnly) {
        for (const record of launch.records) {
          const call = record.message?.parts?.find(
            (part) => part.functionCall?.id === launch.callId,
          )?.functionCall;
          if (record.type === 'assistant' && call) {
            appendObservation(
              { ...record, goalContext: launch.permit },
              call,
              `agent:${node.agentId}`,
              {
                agentId: node.agentId,
                status: 'running',
                executionAllowedTools: meta.executionAllowedTools,
                observation:
                  'This child continues under an enforced read-only tool allowlist. Its future reads are not frozen; evaluate whether this policy also satisfies every Goal-wide action restriction.',
              },
              result.records,
            );
            break;
          }
        }
      }
      result.records.push(...mapped.records);
      if (active && mapped.coverageUnavailable.length > 0) {
        (result.activeWriters ??= []).push(
          `Child agent ${node.agentId} has incomplete live action coverage.`,
        );
      }
      for (const reason of mapped.coverageUnavailable) unavailable(reason);
      const recordedCallCount = mapped.records.reduce(
        (count, record) =>
          count +
          (record.message?.parts ?? []).filter((part) => part.functionCall)
            .length,
        0,
      );
      const parentCounts = launch.records.flatMap((record) => {
        const context = record.goalContext as GoalTurnPermit | undefined;
        const result = record.toolCallResult as
          | {
              callId?: string;
              resultDisplay?: {
                executionSummary?: { totalToolCalls?: unknown };
              };
            }
          | undefined;
        if (
          record.type !== 'tool_result' ||
          context?.goalId !== launch.permit.goalId ||
          context.revision !== launch.permit.revision ||
          context.turnId !== launch.permit.turnId ||
          result?.callId !== launch.callId
        )
          return [];
        const count = result.resultDisplay?.executionSummary?.totalToolCalls;
        return typeof count === 'number' &&
          Number.isSafeInteger(count) &&
          count >= 0
          ? [count]
          : [];
      });
      const counts =
        meta.auditToolCalls !== undefined
          ? [meta.auditToolCalls]
          : (meta.resumeCount ?? 0) === 0
            ? [...(meta.stats ? [meta.stats.toolUses] : []), ...parentCounts]
            : [];
      if (!active && counts.length === 0) {
        unavailable(
          `Child agent ${node.agentId} has no independently recorded action count to establish transcript completeness.`,
        );
      }
      if (
        !active &&
        counts.some(
          (count) =>
            !Number.isSafeInteger(count) ||
            count < 0 ||
            count !== recordedCallCount,
        )
      ) {
        unavailable(
          `Child agent ${node.agentId} transcript action count does not match its independently recorded tool uses.`,
        );
      }
      const childLaunches = findLaunches(
        records.map((record) => ({
          ...record,
          goalContext: launch.permit,
          provenance:
            record.type === 'assistant'
              ? ('assistant_output' as const)
              : undefined,
        })),
        launch.permit,
        node.agentId,
      );
      await readBackgroundActions(
        records.map((record) => ({
          ...record,
          goalContext: launch.permit,
          parentToolCallId: launch.parentAgentId
            ? `${launch.parentAgentId}:${launch.callId}`
            : launch.callId,
          provenance:
            record.type === 'assistant'
              ? ('assistant_output' as const)
              : undefined,
        })),
        launch.permit,
        input.liveTasks,
        result,
        (value) => stamp.update(value),
        unavailable,
        messagedAgents,
        backgroundDir,
      );
      launches.push(...childLaunches);
      const knownCalls = new Set(childLaunches.map((child) => child.callId));
      for (const child of nodes) {
        if (
          child.parentAgentId === node.agentId &&
          (!child.toolUseId || !knownCalls.has(child.toolUseId))
        ) {
          unavailable(
            `Child agent ${child.agentId} has no matching recorded launch in parent ${node.agentId}.`,
          );
        }
      }
    }
  }
  checkMessageCoverage();
  result.fingerprint = stamp.digest('hex');
  return result;
}

function findLaunches(
  records: readonly GoalEvidenceRecord[],
  permit: GoalTurnPermit,
  parentAgentId: string | null,
): ChildLaunch[] {
  return records.flatMap((record) => {
    const context = record.goalContext as Partial<GoalTurnPermit> | undefined;
    if (
      record.type !== 'assistant' ||
      record.provenance !== 'assistant_output' ||
      !context ||
      context.goalId !== permit.goalId ||
      context.revision !== permit.revision ||
      typeof context.turnId !== 'string' ||
      !context.turnId
    )
      return [];
    return (record.message?.parts ?? []).flatMap((part) => {
      const call = part.functionCall;
      return part.thought !== true &&
        call?.id &&
        call.name &&
        LAUNCH_TOOLS.has(call.name)
        ? [
            {
              callId: call.id,
              toolName: call.name,
              permit: {
                goalId: permit.goalId,
                revision: permit.revision,
                turnId: context.turnId!,
              },
              parentAgentId,
              records,
            },
          ]
        : [];
    });
  });
}

function didNotStart(launch: ChildLaunch): boolean {
  let ready: boolean | undefined;
  for (const record of launch.records) {
    const context = record.goalContext as GoalTurnPermit | undefined;
    if (
      context?.goalId !== launch.permit.goalId ||
      context.revision !== launch.permit.revision ||
      context.turnId !== launch.permit.turnId
    )
      continue;
    const payload = record.systemPayload as Record<string, unknown> | undefined;
    if (
      record.subtype === 'agent_session_ready' &&
      payload?.['callId'] === launch.callId &&
      typeof payload['subagentSessionReady'] === 'boolean'
    ) {
      ready = payload['subagentSessionReady'];
    }
    const result = record.toolCallResult as Record<string, unknown> | undefined;
    const display = result?.['resultDisplay'] as
      | Record<string, unknown>
      | undefined;
    if (
      result?.['callId'] === launch.callId &&
      result['executionStatus'] === 'not_started'
    )
      return true;
    if (result?.['callId'] === launch.callId && result['status'] === 'error') {
      if (display?.['subagentSessionReady'] === false || ready === false)
        return true;
    }
  }
  return false;
}

function matchesNode(
  meta: AgentMeta,
  node: AgentTraceNode,
  sessionId: string,
): boolean {
  return (
    meta !== null &&
    typeof meta === 'object' &&
    meta.agentId === node.agentId &&
    meta.parentSessionId === sessionId &&
    meta.parentAgentId === node.parentAgentId &&
    meta.toolUseId === node.toolUseId &&
    meta.createdAt === node.createdAt &&
    meta.status === node.status
  );
}

function parseTranscript(
  raw: string,
  agentId: string,
  sessionId: string,
): ChatRecord[] {
  if (!raw.trim() || !raw.endsWith('\n'))
    throw new Error('Incomplete child transcript');
  const records: ChatRecord[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n').filter((line) => line.trim())) {
    const value = JSON.parse(line) as ChatRecord;
    if (
      !value ||
      typeof value.uuid !== 'string' ||
      !value.uuid ||
      seen.has(value.uuid) ||
      value.sessionId !== sessionId ||
      value.agentId !== agentId ||
      value.isSidechain !== true ||
      typeof value.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(value.timestamp)) ||
      !['user', 'assistant', 'tool_result', 'system'].includes(value.type) ||
      (value.parentUuid !== null && !seen.has(value.parentUuid)) ||
      (records.length === 0 && value.parentUuid !== null) ||
      (value.message !== undefined &&
        (!Array.isArray(value.message.parts) ||
          value.message.parts.some(
            (part) => !part || typeof part !== 'object' || Array.isArray(part),
          )))
    )
      throw new Error('Invalid child record');
    seen.add(value.uuid);
    records.push(value);
  }
  return records;
}

function mapActions(
  records: ChatRecord[],
  permit: GoalTurnPermit,
  agentId: string,
  liveReadOnly: boolean,
  parentToolCallId: string,
): Pick<GoalChildEvidence, 'records' | 'coverageUnavailable'> {
  const result: Pick<GoalChildEvidence, 'records' | 'coverageUnavailable'> = {
    records: [],
    coverageUnavailable: [],
  };
  const pending = new Set<string>();
  const calls = new Set<string>();
  for (const record of records) {
    if (record.type === 'assistant') {
      const parts: Part[] = [];
      for (const part of record.message?.parts ?? []) {
        const call = part.functionCall;
        if (part.thought === true || !call) continue;
        if (
          typeof call.id !== 'string' ||
          !call.id ||
          typeof call.name !== 'string' ||
          !call.name ||
          calls.has(call.id) ||
          !call.args ||
          typeof call.args !== 'object' ||
          Array.isArray(call.args)
        ) {
          result.coverageUnavailable.push(
            `Child agent ${agentId} has a missing or ambiguous tool call identity/arguments.`,
          );
          continue;
        }
        calls.add(call.id);
        pending.add(call.id);
        if (liveReadOnly && !READ_ONLY_TOOLS.has(call.name)) {
          result.coverageUnavailable.push(
            `Child agent ${agentId} recorded an action outside its claimed read-only policy.`,
          );
        }
        parts.push({ functionCall: { ...call, id: `${agentId}:${call.id}` } });
      }
      if (parts.length > 0)
        result.records.push({
          uuid: record.uuid,
          timestamp: record.timestamp,
          agentId,
          parentToolCallId,
          type: 'assistant',
          provenance: 'assistant_output',
          goalContext: permit,
          message: { parts },
        });
    }
    if (record.type === 'tool_result') {
      const parts = (record.message?.parts ?? [])
        .filter((part) => part.thought !== true)
        .map((part): Part => {
          const response = part.functionResponse;
          if (!response) return part;
          const id = response.id ?? record.toolCallResult?.callId;
          if (!id || !pending.delete(id))
            result.coverageUnavailable.push(
              `Child agent ${agentId} has a tool result without a unique recorded call.`,
            );
          return {
            ...part,
            functionResponse: {
              ...response,
              ...(id ? { id: `${agentId}:${id}` } : {}),
            },
          };
        });
      result.records.push({
        uuid: record.uuid,
        timestamp: record.timestamp,
        agentId,
        parentToolCallId,
        type: 'tool_result',
        provenance: 'tool_result',
        goalContext: permit,
        message: { parts },
        sourceComplete: (record as GoalEvidenceRecord).sourceComplete,
        missingReason: (record as GoalEvidenceRecord).missingReason,
        ...(record.toolCallResult
          ? {
              toolCallResult: {
                ...record.toolCallResult,
                callId: record.toolCallResult.callId
                  ? `${agentId}:${record.toolCallResult.callId}`
                  : undefined,
              },
            }
          : {}),
      });
    }
  }
  if (pending.size > 0 && !liveReadOnly)
    result.coverageUnavailable.push(
      `Child agent ${agentId} has tool calls whose results were not recorded: ${[...pending].join(', ')}.`,
    );
  if (liveReadOnly) {
    for (const record of result.records.slice()) {
      for (const part of record.message?.parts ?? []) {
        const call = part.functionCall;
        if (!call?.id || !pending.has(call.id.slice(agentId.length + 1)))
          continue;
        result.records.push({
          uuid: `pending-read-only:${call.id}`,
          timestamp: new Date().toISOString(),
          agentId,
          parentToolCallId,
          type: 'tool_result',
          provenance: 'tool_result',
          goalContext: permit,
          message: {
            parts: [
              {
                functionResponse: {
                  id: call.id,
                  name: call.name,
                  response: {
                    executionStatus: 'running',
                    readOnlyEnforced: true,
                    resultAvailable: false,
                    observation:
                      'The verified read-only child tool is still running; no completed output has been recorded.',
                  },
                },
              },
            ],
          },
        });
      }
    }
  }
  return result;
}

async function readBackgroundActions(
  records: readonly GoalEvidenceRecord[],
  permit: GoalTurnPermit,
  liveTasks: GoalEvidenceLiveTasks | undefined,
  result: GoalChildEvidence,
  stamp: (value: string) => unknown,
  unavailable: (reason: string) => void,
  messagedAgents: Set<string | undefined>,
  backgroundDir?: string,
): Promise<void> {
  for (const record of records) {
    const context = record.goalContext as GoalTurnPermit | undefined;
    if (
      record.type !== 'assistant' ||
      record.provenance !== 'assistant_output' ||
      context?.goalId !== permit.goalId ||
      context.revision !== permit.revision ||
      typeof context.turnId !== 'string' ||
      !context.turnId
    )
      continue;
    for (const part of record.message?.parts ?? []) {
      const call = part.functionCall;
      if (part.thought || !call?.id || !call.name) continue;
      const response = records.find((entry) => {
        const resultContext = entry.goalContext as GoalTurnPermit | undefined;
        return (
          entry.type === 'tool_result' &&
          resultContext?.goalId === context.goalId &&
          resultContext.revision === context.revision &&
          resultContext.turnId === context.turnId &&
          ((entry.toolCallResult as { callId?: string } | undefined)?.callId ===
            call.id ||
            entry.message?.parts?.some((part) => {
              const functionResponse = part.functionResponse;
              return (
                functionResponse?.id === call.id &&
                functionResponse?.name === call.name
              );
            }))
        );
      });
      const metadata = response?.toolCallResult as
        | {
            resultDisplay?: unknown;
            executionStatus?: string;
            errorType?: string;
          }
        | undefined;
      if (metadata?.executionStatus === 'not_started') continue;
      if (
        call.name === ToolNames.SEND_MESSAGE &&
        metadata?.errorType === ToolErrorType.SEND_MESSAGE_NOT_FOUND
      )
        continue;
      if (call.name === ToolNames.SEND_MESSAGE)
        messagedAgents.add(
          typeof call.args?.['task_id'] === 'string'
            ? call.args['task_id']
            : undefined,
        );
      if (call.name === ToolNames.WORKFLOW) {
        const workflow = liveTasks?.workflows.find(
          (entry) => entry.toolUseId === call.id,
        );
        if (!workflow) {
          (result.activeWriters ??= []).push(
            `Workflow call ${call.id} has no verified terminal execution state.`,
          );
          unavailable(
            `Workflow call ${call.id} has no verifiable current execution state or child action lineage.`,
          );
        } else {
          stamp(
            JSON.stringify([
              workflow.runId,
              workflow.toolUseId,
              workflow.status,
              workflow.agentsDispatched,
              workflow.startTime,
              workflow.endTime,
            ]),
          );
          if (!['completed', 'failed', 'cancelled'].includes(workflow.status)) {
            (result.activeWriters ??= []).push(
              `Workflow ${workflow.runId} may still modify the Goal target.`,
            );
            unavailable(
              `Workflow ${workflow.runId} may still modify the Goal target.`,
            );
          }
          appendObservation(
            record,
            call,
            `workflow:${workflow.runId}`,
            { ...workflow },
            result.records,
          );
        }
      }
      if (call.name !== ToolNames.SHELL) continue;
      const display =
        typeof metadata?.resultDisplay === 'string'
          ? metadata.resultDisplay
          : '';
      const responseText = (response?.message?.parts ?? [])
        .map((part) => JSON.stringify(part.functionResponse?.response ?? ''))
        .join('\n');
      const shellId =
        /^(?:Background shell |Promoted to background: )(bg_[a-f0-9]+)(?: started|$)/.exec(
          display,
        )?.[1] ??
        /Background shell started\.\\nid: (bg_[a-f0-9]+)\\n/.exec(
          responseText,
        )?.[1] ??
        /promoted to background as (bg_[a-f0-9]+)\./.exec(responseText)?.[1];
      if (!shellId && call.args?.['is_background'] !== true) continue;
      const shell =
        liveTasks?.shells.find((entry) => entry.shellId === shellId) ??
        (shellId && backgroundDir
          ? await readPersistedShell(shellId, backgroundDir)
          : undefined);
      const originalCommand = call.args?.['command'];
      if (
        !shell ||
        typeof originalCommand !== 'string' ||
        (shell.originalCommand !== undefined
          ? shell.originalCommand !== originalCommand
          : shell.command !== originalCommand.trim())
      ) {
        (result.activeWriters ??= []).push(
          `Background shell call ${call.id} has no verified terminal execution state.`,
        );
        unavailable(
          `Background shell call ${call.id} has no verifiable current execution state.`,
        );
        continue;
      }
      stamp(
        JSON.stringify([
          shell.shellId,
          shell.command,
          shell.cwd,
          shell.status,
          shell.exitCode,
          shell.startTime,
          shell.endTime,
          shell.outputFile,
          shell.originalCommand,
          shell.exitObservedAt,
          shell.outputComplete,
        ]),
      );
      if (
        !['completed', 'failed'].includes(shell.status) &&
        !(shell.status === 'cancelled' && shell.exitObservedAt !== undefined)
      ) {
        (result.activeWriters ??= []).push(
          `Background shell ${shell.shellId} process exit has not been observed.`,
        );
        unavailable(
          `Background shell ${shell.shellId} may still modify the Goal target; process exit has not been observed.`,
        );
        continue;
      }
      let output: string;
      let artifactBacked = false;
      try {
        const file = await openNoFollow(shell.outputFile);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw new Error('Not a recorded file');
          stamp(
            JSON.stringify([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]),
          );
          artifactBacked = stat.size > MAX_INLINE_SHELL_OUTPUT_BYTES;
        } finally {
          await file.close();
        }
        output = artifactBacked
          ? 'Full captured output is available in the attached original artifact.'
          : await readRecordedFile(
              shell.outputFile,
              MAX_INLINE_SHELL_OUTPUT_BYTES,
            );
      } catch {
        unavailable(
          `Background shell ${shell.shellId} completed output is unavailable.`,
        );
        continue;
      }
      stamp(output);
      appendObservation(
        record,
        call,
        `shell:${shell.shellId}`,
        {
          status: shell.status,
          exitCode: shell.exitCode,
          command: shell.command,
          cwd: shell.cwd,
          endTime: shell.exitObservedAt ?? shell.endTime,
          output,
        },
        result.records,
      );
      const observation = result.records.at(-1)!;
      if (artifactBacked) observation.persistedOutputFiles = [shell.outputFile];
      if (shell.outputComplete === false) {
        observation.sourceComplete = false;
        observation.missingReason = `Background shell ${shell.shellId} output did not finish flushing successfully.`;
        unavailable(observation.missingReason);
      }
    }
  }
}

async function readRecordedFile(
  filePath: string,
  maxBytes = MAX_RECORDED_FILE_BYTES,
): Promise<string> {
  const file = await openNoFollow(filePath);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes)
      throw new Error('Recorded file exceeds the read limit');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Recorded file changed while reading');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

async function readPersistedShell(
  shellId: string,
  directory: string,
): Promise<GoalEvidenceLiveTasks['shells'][number] | undefined> {
  try {
    const value = JSON.parse(
      await readRecordedFile(path.join(directory, `shell-${shellId}.status`)),
    ) as Record<string, unknown>;
    if (
      value['id'] !== shellId ||
      typeof value['command'] !== 'string' ||
      typeof value['cwd'] !== 'string' ||
      typeof value['status'] !== 'string' ||
      !['running', 'completed', 'failed', 'cancelled'].includes(
        value['status'],
      ) ||
      typeof value['startTime'] !== 'string' ||
      !Number.isFinite(Date.parse(value['startTime'])) ||
      (value['endTime'] !== undefined &&
        (typeof value['endTime'] !== 'string' ||
          !Number.isFinite(Date.parse(value['endTime'])))) ||
      (value['exitCode'] !== undefined &&
        (typeof value['exitCode'] !== 'number' ||
          !Number.isInteger(value['exitCode'])))
    )
      return undefined;
    return {
      shellId,
      command: value['command'],
      ...(typeof value['originalCommand'] === 'string'
        ? { originalCommand: value['originalCommand'] }
        : {}),
      ...(typeof value['exitObservedAt'] === 'number' &&
      Number.isFinite(value['exitObservedAt'])
        ? { exitObservedAt: value['exitObservedAt'] }
        : {}),
      ...(typeof value['outputComplete'] === 'boolean'
        ? { outputComplete: value['outputComplete'] }
        : {}),
      cwd: value['cwd'],
      status: value['status'],
      outputFile: path.join(directory, `shell-${shellId}.output`),
      startTime: Date.parse(value['startTime']),
      ...(typeof value['endTime'] === 'string'
        ? { endTime: Date.parse(value['endTime']) }
        : {}),
      ...(typeof value['exitCode'] === 'number'
        ? { exitCode: value['exitCode'] }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function appendObservation(
  record: GoalEvidenceRecord,
  call: NonNullable<Part['functionCall']>,
  identity: string,
  response: Record<string, unknown>,
  records: GoalEvidenceRecord[],
): void {
  const id = `background-status:${identity}`;
  records.push(
    {
      uuid: `${id}:call`,
      timestamp: record.timestamp,
      agentId: record.agentId,
      parentToolCallId: record.parentToolCallId,
      type: 'assistant',
      provenance: 'assistant_output',
      goalContext: record.goalContext,
      message: { parts: [{ functionCall: { ...call, id } }] },
    },
    {
      uuid: `${id}:result`,
      timestamp:
        typeof response['endTime'] === 'number' &&
        Number.isFinite(response['endTime'])
          ? new Date(response['endTime']).toISOString()
          : response['status'] === 'running'
            ? new Date().toISOString()
            : undefined,
      agentId: record.agentId,
      parentToolCallId: record.parentToolCallId,
      type: 'tool_result',
      provenance: 'tool_result',
      goalContext: record.goalContext,
      message: {
        parts: [
          {
            functionResponse: {
              id,
              name: call.name,
              response: {
                ...response,
                observedAt: new Date().toISOString(),
                sourceCallId: record.agentId
                  ? `${record.agentId}:${call.id}`
                  : call.id,
                observationKind: 'host_background_task_state',
              },
            },
          },
        ],
      },
    },
  );
}
