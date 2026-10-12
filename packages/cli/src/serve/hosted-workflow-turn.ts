/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Part } from '@google/genai';
import { parseDefinitionPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import type { DefinitionPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { WorkflowRunner } from '@qwen-code/qwen-code-core/agents/runtime/workflow-runner.js';
import type { WorkflowRunOutcome } from '@qwen-code/qwen-code-core/agents/runtime/workflow-orchestrator.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import {
  applyHostedModelPin,
  type HostedHarnessModelResult,
} from './hosted-harness-model.js';
import {
  HostedModelUnavailableError,
  type HostedAgentDefinition,
} from './hosted-agent-definition.js';

// #13803 (K1): the workflow child Session's first Turn executes a workflow
// instead of a prompt. The Java creation arm mints the Turn with one
// `workflow_launch` input block; this module is the daemon-side executor —
// it re-verifies the launch pin against the script bytes before anything
// runs (decision 2), drives the ordinary headless WorkflowRunner
// in-process (decision 4), and renders the settled outcome as the Turn's
// final content, bounded so the relay's 64 KiB result copy always fits.
// The script's agent() calls dispatch to in-process AgentHeadless
// subagents under the ordinary background posture — safe calls
// auto-allow, approval-needing calls are denied model-visibly, nothing
// interactive exists — never managed grandchild Sessions (decision 5).

export const HOSTED_WORKFLOW_LAUNCH_BLOCK = 'workflow_launch';

/** The workflow payload of a `workflow_launch` prompt block. */
export interface HostedWorkflowLaunch {
  readonly definition: DefinitionPin;
  readonly script: string;
  readonly args: unknown;
}

/**
 * Parses one prompt block as a workflow launch, or returns undefined. The
 * block's closed keys are `type`, `definition`, `script` and an optional
 * `args`; the pin's shape is the record contract's own (`definitionId` id
 * text, `definitionRevision` count from 1, `definitionDigest` lowercase
 * SHA-256 hex), as the route's boundary mirror of the envelope decoder.
 */
export function parseHostedWorkflowLaunchBlock(
  value: unknown,
): HostedWorkflowLaunch | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  const block = value as Record<string, unknown>;
  const keys = Object.keys(block).sort();
  if (
    block['type'] !== HOSTED_WORKFLOW_LAUNCH_BLOCK ||
    keys.join(',') !==
      (block['args'] === undefined
        ? 'definition,script,type'
        : 'args,definition,script,type') ||
    typeof block['script'] !== 'string' ||
    block['script'].length === 0
  ) {
    return undefined;
  }
  const definition = block['definition'];
  // The pin's shape and id bounds are the record layer's own: delegate
  // so both lanes refuse the same bytes (the hand-rolled check used to
  // admit a 513-byte or control-character definitionId the envelope
  // decoder beside it refused).
  try {
    const parsed = parseDefinitionPin(definition, 'workflow launch definition');
    return {
      definition: parsed,
      script: block['script'],
      args: block['args'],
    };
  } catch {
    return undefined;
  }
}

/** The one-line journal summary of a launched workflow child. */
export function workflowLaunchSummaryText(
  launch: HostedWorkflowLaunch,
): string {
  return `<workflow ${launch.definition.definitionId}@${launch.definition.definitionRevision} sha256:${launch.definition.definitionDigest.slice(0, 16)}>`;
}

/**
 * The workflow outcome could not settle completed: carried to the Turn's
 * catch so the settlement names the run's own failure — aborted arms land
 * on cancelled through the ordinary signal check, everything else on
 * turn error and the relay's `child_failed` (decision 4's 4b row).
 */
export class HostedWorkflowTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedWorkflowTurnError';
  }
}

/** The run did not settle ok: its message is the evidence, never thrown raw. */
function describeFailure(message: string, details?: unknown): string {
  const rendered =
    details === undefined
      ? message
      : `${message} (${safeJson(details).slice(0, 2048)})`;
  return `Workflow run failed: ${rendered}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The content bound one Turn's final workflow text carries, sitting far
 * below both the Session Store inline limit and the relay's 64 KiB result
 * copy bound even after JSON and XML escape inflation.
 */
const WORKFLOW_TURN_RESULT_LIMIT = 32 * 1024;

function bounded(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= WORKFLOW_TURN_RESULT_LIMIT) {
    return text;
  }
  // R1-5: never spread the whole outcome into a code-point array — the
  // byte check usually makes it unnecessary, and the walk-back below costs
  // one buffer instead of an array plus a slice-and-join per search step.
  // R1-32: no pointer to the run snapshot — it lives on the Harness host,
  // which this Session's tools never read, and an unwritten one would send
  // the model to nothing. The script itself is what can return less.
  const marker = `\n… (truncated: the outcome exceeded ${WORKFLOW_TURN_RESULT_LIMIT} bytes; have the script return a smaller result to see all of it)`;
  const budget = WORKFLOW_TURN_RESULT_LIMIT - Buffer.byteLength(marker, 'utf8');
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(budget, bytes.length);
  // Walk back to a code-point boundary: a UTF-8 continuation byte carries
  // the 0x80 low bits, so ending on one would split a sequence.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end).toString('utf8') + marker;
}

function renderOutcome(outcome: WorkflowRunOutcome): string {
  const sections = [
    `Workflow run ${outcome.runId} completed.`,
    'Result:',
    safeJson(outcome.result ?? null),
  ];
  if (outcome.phases.length > 0) {
    sections.push(
      'Phases:',
      outcome.phases.map((phase) => `- ${phase}`).join('\n'),
    );
  }
  if (outcome.logs.length > 0) {
    sections.push('Logs:', outcome.logs.join('\n'));
  }
  return bounded(sections.join('\n'));
}

/** The shape the caller commits and classifies like any model answer. */
export async function runHostedWorkflowTurn(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly launch: HostedWorkflowLaunch;
  readonly signal: AbortSignal;
  /** The Session's pinned definition: its model governs every agent()
   * dispatch of the run, exactly as it governs the sibling text Turn. */
  readonly agentDefinition?: HostedAgentDefinition;
}): Promise<HostedHarnessModelResult> {
  // The pin binds the bytes that run: the launch's digest must equal the
  // script's own, or this Turn never starts (decision 2).
  const digest = createHash('sha256')
    .update(input.launch.script, 'utf8')
    .digest('hex');
  if (digest !== input.launch.definition.definitionDigest) {
    throw new HostedWorkflowTurnError(
      `Workflow launch pin does not match its script: pinned ${input.launch.definition.definitionDigest.slice(0, 16)}, script ${digest.slice(0, 16)}.`,
    );
  }
  const settings = loadSettings(input.cwd, {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: true,
    workspaceTrusted: false,
  });
  const argv = {
    acp: true,
    safeMode: true,
    chatRecording: false,
    sessionId: input.sessionId,
  } as CliArgs;
  // The config is the per-turn hosted shape (safeMode, untrusted
  // Workspace), with NO tool-invocation guard refitted onto it: the
  // runner's AgentHeadless subagents need the ordinary headless registry
  // posture, where destructive calls are denied model-visibly instead of
  // everything failing the same way (decision 5). A fresh config is
  // unauthenticated and uninitialized until told otherwise: its registry
  // exists only after initialize() and its content generator only after
  // refreshAuth() — both are exactly what an agent() dispatch reads, so
  // a script with agent() calls needs the sibling text turn's lifecycle,
  // not a bare loadCliConfig (runHostedHarnessTextTurn's own per-turn
  // pattern, mirrored).
  //
  // Every agent() chat opens with this config's startup context unless it
  // is skipped: this Harness's cwd and a listing of it, which is host
  // filesystem metadata and never the Session's Workspace. The sibling text
  // turn replaces that prelude with the Session's own history; these agents
  // have none to replace it with, so they start without it.
  const config = await loadCliConfig(
    {
      ...settings.merged,
      model: { ...settings.merged.model, skipStartupContext: true },
    },
    argv,
    input.cwd,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  const model = input.agentDefinition?.model;
  await applyHostedModelPin(config, model);
  try {
    await config.initialize({
      signal: input.signal,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipSkillManager: true,
      skipFileCheckpointing: true,
      lenientToolWarmup: true,
    });
    const authType = config.getModelsConfig().getCurrentAuthType();
    if (!authType) {
      throw new Error('Hosted Harness model authentication is unavailable.');
    }
    try {
      await config.refreshAuth(authType, true);
    } catch (cause) {
      if (model) throw new HostedModelUnavailableError(cause);
      throw cause;
    }
    const handle = await WorkflowRunner.start({
      config,
      signal: input.signal,
      script: input.launch.script,
      args: input.launch.args ?? undefined,
      // Admission refuses a script that lexically calls `workflow(`; this
      // runtime line refuses every nested resolution, by name or path,
      // because this run may execute only the bytes its pin examined.
      restrictNestedScriptPaths: true,
      refuseNestedWorkflows: true,
      // The in-process subagents' tools would dispatch against this
      // Harness's own cwd and host, never the Session's Workspace — until
      // they route through the Hosted broker, the child declares none.
      refuseSubagentTools: true,
    });
    input.signal.addEventListener('abort', () => handle.abort(), {
      once: true,
    });
    const settlement = await handle.completion;
    if (!settlement.ok) {
      throw new HostedWorkflowTurnError(
        describeFailure(settlement.message, settlement.details),
      );
    }
    const text = renderOutcome(settlement.outcome);
    const parts: Part[] = [{ text }];
    return Object.freeze({ text, parts, model: 'workflow' });
  } finally {
    try {
      await config.shutdown({
        shutdownTelemetry: false,
        strictResourceCleanup: true,
      });
    } catch (cause) {
      writeStderrLineSafe(
        `qwen serve: Hosted Harness model cleanup failed: ${String(cause)}`,
      );
    }
  }
}
