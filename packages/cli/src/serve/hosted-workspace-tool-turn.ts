/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  oweHostedTurnCleanup,
  reconcileHostedTurnCleanup,
  confirmReplacedHostedTurnOwner,
} from './hosted-turn-cleanup.js';
import { rejectionDetail } from './hosted-never-started-reconcile.js';

import {
  readHostedFileHistory,
  commitHostedFileHistory,
  assertHostedFileHistoryCapacity,
  HostedFileHistoryRefusedError,
  canSettleHostedFileHistory,
  type HostedFileHistorySettleBlocker,
} from './hosted-file-history.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  checkHostedGlobPattern,
  HOSTED_GLOB_TOO_COMPLEX,
} from './hosted-glob-pattern.js';
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HOSTED_WORKSPACE_FILE_PROFILE_V2,
  HOSTED_WORKSPACE_SHELL_PROFILE_V2,
  isHostedWorkspaceProfile,
  isHostedWorkspaceShellProfile,
  isHostedWorkspaceSearchProfile,
  type HostedWorkspaceToolProfile,
} from './hosted-workspace-profiles.js';
import type { FunctionDeclaration, Part } from '@google/genai';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import {
  convertToFunctionResponse,
  convertToFunctionErrorResponse,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  managedToolDigest,
  ManagedToolProtocolError,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  createToolPublicationToken,
  parseToolPublicationBinding,
  type ToolPublicationBinding,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-publication.js';
import type { HttpToolPublicationOwner } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  parseToolResultEnvelope,
  type ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  assertManagedSessionChildRunKindEnabled,
  assertManagedSessionDomainEnabled,
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  ManagedSessionWritesStoppedError,
  type ManagedSessionDomain,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  harnessCommandLocked,
  type HarnessAgentWaitRun,
  type HarnessCommandWaitRun,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import {
  HTTP_MANAGED_SESSION_STORE_CONTRACT,
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import type {
  HostedApprovalContinuation,
  RestoredHostedApprovalContinuation,
} from './hosted-approval-continuation.js';
import {
  InvalidWorkspaceRelativePathError,
  normalizeWorkspaceRelativePath,
} from './managed-workspace-binding.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import {
  HostedWorkspaceBroker,
  hostedRuntimeSessionId,
  HostedWorkspaceBrokerRejection,
  isHostedFileHistoryRefusal,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { MANAGED_WORKSPACE_CONTEXT_FILES } from './managed-runtime-provider-protocol.js';
import type { HostedMcpSession } from './hosted-mcp-session.js';
import type {
  HostedHookSession,
  HostedPromptHookRunner,
} from './hosted-hook-session.js';
import type { HostedChildRunSession } from './hosted-child-run-session.js';
import type { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  childLaunchAdmission,
  childKindLabel,
  childRunEndedText,
  childWorkspaceAnswerSuffix,
} from './hosted-child-agent-session.js';
import {
  memberMessageContent,
  type HostedSessionMessageSession,
} from './hosted-session-message-session.js';
import { sessionMessageId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import { MANAGED_SESSION_MESSAGE_LIMITS } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import { sanitizeName } from '@qwen-code/qwen-code-core/agents/team/teamHelpers.js';
import {
  ACTIVE_FORM_CHARS,
  DESCRIPTION_CHARS,
  HOSTED_TEAM_TOOLS,
  HOSTED_TEAM_PLAN_TOOL,
  HOSTED_TEAM_TOOL_NAMES,
  HostedTeamRefusal,
  hostedTeamArgumentError,
  hostedTeamMembership,
  SUBJECT_CHARS,
  TASK_STATUSES,
  type HostedTeamMembership,
  type HostedTeamSession,
} from './hosted-team-session.js';
import {
  encodeChildLaunchEnvelope,
  encodeWorkflowLaunchEnvelope,
  MANAGED_CHILD_LIMITS,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import type { DefinitionPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  ARGS_MAX_DEPTH,
  extractAndStripMeta,
  workflowPreLaunchGate,
} from '@qwen-code/qwen-code-core/agents/runtime/workflow-sandbox.js';
import { WORKFLOW_NAME_PATTERN } from '@qwen-code/qwen-code-core/agents/runtime/workflow-saved.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { managedChildTaskId } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import type { HostedMonitorSession } from './hosted-monitor-session.js';
import {
  HOSTED_BROADCAST_POSITIONS,
  HostedChildChains,
  broadcastMessageId,
  broadcastRunId,
  firstInputOpensWithMemberPreamble,
  hostedCallKey,
  hostedFirstInputText,
  hostedPromptKey,
  hostedRouteDetails,
  memberPreambleIdentity,
  lostMessagesAction,
  neverStartedClause,
  neverStartedPhrase,
  teamMemberPreamble,
} from './hosted-member-chain.js';
import { sessionCommandId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-operations.js';
import type { SessionCommandKind } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-record.js';
import {
  SESSION_COMMAND_LEADER_UNANSWERING_TEXT,
  sessionCommandEvidenceText,
  type HostedSessionCommandSession,
} from './hosted-session-command-session.js';
import { MANAGED_TEAM_LEADER } from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import { HostedMonitorLoop } from './hosted-monitor-loop.js';
import { HostedMonitorRemoteExecutor } from './hosted-monitor-remote-executor.js';
import {
  HookEventName,
  PreToolUseHookOutput,
  createHookOutput,
  type HookOutput,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import { hostedHookOccurrenceId } from './hosted-hook-session.js';
import { parseHookExecution } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import { waitForTurn } from './hosted-turn-wait.js';
import { boundedShellPreview } from './managed-shell-publisher.js';
import {
  HOSTED_SKILL_APPROVAL_REFUSAL,
  HOSTED_SKILL_BATCH_REFUSAL,
  type HostedSkillCatalog,
} from './hosted-skill-catalog.js';
import {
  endHostedAction,
  HOSTED_APPROVAL_OPTIONS,
  HOSTED_TOOL_APPROVAL_POLICY,
  hostedActionAllowed,
  hostedApprovalAsks,
  type HostedActionOptions,
  type HostedApprovalSettings,
  type HostedApprovalWaiters,
} from './hosted-tool-approval.js';

export {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HOSTED_WORKSPACE_FILE_PROFILE_V2,
  HOSTED_WORKSPACE_SHELL_PROFILE_V2,
  isHostedWorkspaceProfile,
  isHostedWorkspaceShellProfile,
  isHostedWorkspaceSearchProfile,
  type HostedWorkspaceToolProfile,
};

const ACQUIRE_BUSY_POLL_MS = 250;
export function isRetryableWorkspaceAcquisition(
  cause: unknown,
): cause is HostedWorkspaceBrokerRejection & {
  code: 'workspace_busy' | 'workspace_unavailable';
} {
  return (
    cause instanceof HostedWorkspaceBrokerRejection &&
    cause.status === 409 &&
    (cause.code === 'workspace_busy' || cause.code === 'workspace_unavailable')
  );
}
function isBusyWorkspaceAcquisition(cause: unknown): boolean {
  return (
    isRetryableWorkspaceAcquisition(cause) && cause.code === 'workspace_busy'
  );
}

export interface HostedShellTurnOptions {
  resources: DurableToolResultResourceStore;
  assertWritable(): Promise<void>;
  // The Session-scoped publisher instance: one server owns every Shell
  // capture of the Session across turns, so background traffic keeps its
  // endpoint after the registering turn ends (H3 fifth slice drains it at
  // the Session's ordered close).
  publisher?: HostedShellPublisher;
  // The Session-scoped observation loops of running Monitor watches,
  // keyed by their execution identity; they outlive their starting turns
  // exactly like the publisher.
  monitorLoops?: Map<string, HostedMonitorLoop>;
  // The embedded wake scheduler's tip: a notification input committed
  // under its observation revision asks the pump to deliver it.
  monitorWakeKick?: () => void;
}

/**
 * The attached Session's fetched Workspace project instructions. `read`
 * returns undefined until the first fetch attempt completes; '' means the
 * Workspace has none. Written once per fetch; `invalidate` returns the slot
 * to undefined so the next native tool turn fetches again.
 */
export interface HostedWorkspaceContextSlot {
  read(): string | undefined;
  write(context: string): void;
  invalidate(): void;
}

/**
 * Whether any Session-relative path names a file the Workspace context read
 * returns, so a change to it must invalidate the cached text (#13564).
 */
export function touchesWorkspaceContext(paths: readonly string[]): boolean {
  return paths.some((file) =>
    (MANAGED_WORKSPACE_CONTEXT_FILES as readonly string[]).includes(file),
  );
}

function shellHistoryId(executionCallId: string): string {
  const bytes = createHash('sha1')
    .update('qwen-hosted-shell-history/1:')
    .update(executionCallId)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// H4d-b: a refusal the store makes at commit (a closing Session, a rule the
// authority holds) is a send_message call's answer, never a failed turn. A
// conflict and the store's own transient faults fail the call like any
// other store fault: a refusal answer would tell the model a message that
// may yet commit was never sent.
function isMessageRefusal(cause: unknown): cause is ManagedSessionRecordError {
  return (
    cause instanceof ManagedSessionRecordError &&
    !(cause instanceof ManagedSessionConflictError) &&
    !(cause instanceof ManagedSessionStoreHttpError) &&
    !(cause instanceof ManagedSessionStoreTransportError) &&
    !(cause instanceof ManagedSessionWritesStoppedError)
  );
}

// H3: background admissions exist only while the child_run domain's shell
// kind is enabled for commits; otherwise the turn keeps its foreground
// refusals. The domain itself never joins the plain enabled list — its
// admission is per kind — so this reads the kind gate (#13856).
function childRunAdmissionsEnabled(): boolean {
  try {
    assertManagedSessionChildRunKindEnabled('shell');
    return true;
  } catch {
    return false;
  }
}

// H3: Monitor admissions exist only while the monitor_run domain is
// enabled for commits; otherwise the turn keeps its monitor refusals.
function monitorRunAdmissionsEnabled(): boolean {
  try {
    assertManagedSessionDomainEnabled('monitor_run');
    return true;
  } catch {
    return false;
  }
}

// H4b: child-agent admissions exist only while the child_run domain's
// child_agent kind is enabled for commits; H3's shell keeps its own gate,
// so this never reads the plain domain list.
function childAgentAdmissionsEnabled(): boolean {
  try {
    assertManagedSessionChildRunKindEnabled('child_agent');
    return true;
  } catch {
    return false;
  }
}

// H4d-b: session message admissions exist only while the session_message
// domain is enabled for commits.
function sessionMessageAdmissionsEnabled(): boolean {
  try {
    assertManagedSessionDomainEnabled('session_message');
    return true;
  } catch {
    return false;
  }
}

// #13803 (K1/K4): workflow-child admissions exist only while the
// child_run domain's workflow kind is enabled for commits — its own
// reader beside the child agent's, so the two kinds' enablement stays
// decoupled in code even while the gate lists both.
function childWorkflowAdmissionsEnabled(): boolean {
  try {
    assertManagedSessionChildRunKindEnabled('workflow');
    return true;
  } catch {
    return false;
  }
}

// H4e-b3: the member board tools exist only while the session_command
// domain is enabled for commits.
function sessionCommandAdmissionsEnabled(): boolean {
  try {
    assertManagedSessionDomainEnabled('session_command');
    return true;
  } catch {
    return false;
  }
}

/**
 * H4e-b3 decision 4: a command's wait bound, measured from the outbound
 * entry's own commit — well inside the Turn deadline and the relay's
 * inactivity bound.
 */
export const COMMAND_WAIT_MS = 120_000;

function teamPlanAdmissionsEnabled(): boolean {
  try {
    assertManagedSessionDomainEnabled('team_plan');
    return true;
  } catch {
    return false;
  }
}

// H4e-b1: the team tools, and the agent tool's `name`, exist only while
// both lead-side team domains are enabled for commits.
function teamAdmissionsEnabled(): boolean {
  try {
    assertManagedSessionDomainEnabled('team_state');
    assertManagedSessionDomainEnabled('team_task');
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk one `args` value for nesting the launch could not commit. The
 * value sits one level under the tool input the protocol digest walks, so
 * the walk starts there and refuses exactly where that digest would throw
 * (64 levels under the input; the sandbox's own ARGS_MAX_DEPTH is the
 * same bound, counted from `args`, so it is never the tighter one). The
 * model fixes the value and retries; nothing commits and no slot or quota
 * is spent.
 */
function workflowArgsRefusal(value: unknown): string | undefined {
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 1 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > ARGS_MAX_DEPTH) {
      return `Hosted workflow args nest more than ${ARGS_MAX_DEPTH - 1} levels deep, past what the launch can commit (depth_limit).`;
    }
    if (node === null || typeof node !== 'object') {
      continue;
    }
    for (const item of Object.values(node)) {
      stack.push({ node: item, depth: depth + 1 });
    }
  }
  return undefined;
}

/**
 * The launch-time definition pin of an inline workflow (#13803 decision
 * 2): id+revision classify, the digest binds the exact bytes the child
 * executes. Inline sources need no revision counter, so revision 1 is the
 * convention, as in the child agent's own pin.
 */
export function workflowDefinitionPin(script: string): DefinitionPin {
  const meta = extractAndStripMeta(script).meta;
  const name =
    meta && WORKFLOW_NAME_PATTERN.test(meta.name) ? meta.name : 'unnamed';
  return Object.freeze({
    definitionId: `workflow/${name}`,
    definitionRevision: 1,
    definitionDigest: createHash('sha256').update(script, 'utf8').digest('hex'),
  });
}

export interface HostedApprovalTurnOptions {
  settings: HostedApprovalSettings;
  waiters: HostedApprovalWaiters;
}

const APPROVAL_REFUSALS = {
  denied: 'The Session owner denied this tool call, so it was not run.',
  expired:
    'Nobody answered the approval request before it expired, so this tool call was not run.',
  cancelled: 'The turn was cancelled before this tool call ran.',
  unanswered:
    'An earlier approval request in this turn expired unanswered, so this tool call was not asked about or run.',
} as const;

// H4b: the two mount refusals a child agent answers with. Exported so
// admission binds its assertions to the marker, not to prose a reword may
// change without changing behaviour.
export const HOSTED_CHILD_MOUNT_REFUSALS = {
  sessionOwner:
    "the Session's Hook catalog or MCP owner holds or will acquire the Workspace mount",
  turn: 'this Turn holds the Workspace mount',
} as const;

const pathProperty = {
  type: 'string',
  description:
    'Path relative to the saved Session working directory in its remote Workspace. Never use the Harness host path.',
};
export const HOSTED_WORKSPACE_FILE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'read_file',
    description:
      'Read a file in the remote Workspace. Read before editing an existing file.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: pathProperty,
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Write a file in the remote Workspace. Read before overwriting an existing file.',
    parametersJsonSchema: {
      type: 'object',
      properties: { file_path: pathProperty, content: { type: 'string' } },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit',
    description:
      'Replace exact text in a remote Workspace file that you have read.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: pathProperty,
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
];

export const HOSTED_WORKSPACE_SHELL_TOOLS: FunctionDeclaration[] = [
  ...HOSTED_WORKSPACE_FILE_TOOLS,
  {
    name: 'run_shell_command',
    description:
      'Run a command in the saved Workspace working directory. Complete stdout and stderr are retained; the model receives a bounded preview. With is_background the command runs detached: the call returns a durable handle at once, the process outlives the turn and holds its Runtime until it exits, and its output lands as a task Artifact. Shell file mutations are not backed up. Changing tracked file content or permissions can cause subsequent Write/Edit and undo conflicts.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', minimum: 1, maximum: 600000 },
        description: { type: 'string' },
        is_background: { type: 'boolean' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'monitor',
    description:
      'Watch a shell command in the saved Workspace working directory and receive its stdout lines as observations while it runs. Observations aggregate by one-second-or-longer debounce windows, so `max_events` counts windows, not lines; `idle_timeout_ms` bounds the silent stretch between windows ending the watch. The watch is admitted only on Sessions whose Monitor path is enabled.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        idle_timeout_ms: { type: 'integer', minimum: 1, maximum: 600000 },
        max_events: { type: 'integer', minimum: 1, maximum: 10000 },
        description: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

const HOSTED_GLOB_TOOL: FunctionDeclaration = {
  name: 'glob',
  description:
    'Find files by name pattern in the remote Workspace, for example "**/*.ts". Returns paths relative to the saved Session working directory, sorted by modification time (newest first).',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: {
        type: 'string',
        description:
          'Directory to search, relative to the saved Session working directory. Omit to search the whole working directory.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};
export const HOSTED_WORKSPACE_FILE_TOOLS_V2: FunctionDeclaration[] = [
  ...HOSTED_WORKSPACE_FILE_TOOLS,
  HOSTED_GLOB_TOOL,
];
export const HOSTED_WORKSPACE_SHELL_TOOLS_V2: FunctionDeclaration[] = [
  ...HOSTED_WORKSPACE_SHELL_TOOLS,
  HOSTED_GLOB_TOOL,
];

// Native tools whose Action carries the captured input, so the approval card
// shows the arguments of the call being answered. This is a cross-service
// contract: it must stay byte-identical to the Java reader's closed
// `ManagedActionService.PREVIEW_TOOLS`. A name missing here writes a version 1
// Action with no input reference; a name missing there makes the reader return
// no preview. Both degrade silently into the card's "Tool arguments are
// unavailable for this approval." fallback, so a test enumerates the set.
export const HOSTED_INPUT_PREVIEW_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'edit',
  'run_shell_command',
  'agent',
  'send_message',
  'team_create',
  'task_create',
  'task_update',
  'workflow',
  'request_shutdown',
  'exit_plan_mode',
  'team_plan_approval',
];

/**
 * H4e-b3 decision 9 (b3a): what a run in plan mode still admits. This
 * build declares neither `task_list` for a member (b3b) nor
 * `exit_plan_mode` (b3d), so the list holds only the reads a member
 * already has, plus its message to the leader.
 */
const HOSTED_PLAN_MODE_READS: ReadonlySet<string> = new Set([
  'read_file',
  'glob',
  'task_list',
  'send_message',
]);

/**
 * The b3a plan-mode refusal, worded for a build without `exit_plan_mode`
 * (decision 5): it says the run may only read and never names it.
 */
function hostedPlanModeRefusal(): string {
  return `This run is in plan mode until the leader approves its plan: only read_file, glob, task_list${teamPlanAdmissionsEnabled() ? ', exit_plan_mode' : ''} and send_message to the leader are admitted. The decision arrives as your next instruction.`;
}

export const HOSTED_MEMBER_PLAN_TOOL: FunctionDeclaration = {
  name: 'exit_plan_mode',
  description:
    'Submit your plan to the leader, then end your turn. The decision arrives as your next instruction; this run remains read-only.',
  parametersJsonSchema: {
    type: 'object',
    properties: { plan: { type: 'string', minLength: 1 } },
    required: ['plan'],
    additionalProperties: false,
  },
};

/**
 * H4b: launch one child Session from the Session's own definition. The
 * result crosses exactly once: a background child completes through a
 * later durable notification input, a foreground child through its own
 * tool result — never both paths.
 */
export const HOSTED_AGENT_TOOL: FunctionDeclaration = {
  name: 'agent',
  description:
    "Launch one child agent as an independent Session of this Workspace, running this Session's own agent definition. Runs in the background by default: the child's terminal result arrives later as a notification input. With run_in_background false the call waits and returns the child's result directly. A child never inherits this Session's model context; give it a complete prompt. Nesting, custom subagent types and isolated workspaces are unavailable in this profile.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'A short label for the child task, at most 512 bytes.',
      },
      prompt: {
        type: 'string',
        description: 'The complete first prompt the child Session runs.',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'Run the child in the background and notify at completion (default true).',
      },
    },
    required: ['description', 'prompt'],
    additionalProperties: false,
  },
};

/**
 * #13803 (K1): launch one child Session that runs one workflow instead of a
 * prompt. The script is the complete definition: the child executes exactly
 * these bytes, digest-pinned from the launch on and re-verified before it
 * runs. The result crosses on the same arms as a child agent — background
 * by default through a durable notification, or folded into this tool
 * result when run_in_background is false.
 */
/** The posture of a managed workflow's agents, stated once for the
 * declaration and the admission refusal. */
const HOSTED_WORKFLOW_TEXT_ONLY_AGENTS =
  'In this profile agent() runs text-only agents: they carry no tools and use nothing on the host, so tools, agentType, isolation and workingDir are unavailable; model, effort and schema still apply.';

export const HOSTED_WORKFLOW_TOOL: FunctionDeclaration = {
  name: 'workflow',
  description: `Launch one workflow as an independent child Session of this Workspace. The script is deterministic JavaScript with the injected globals phase(), log(), agent(), parallel(), pipeline(), args and budget, and cannot import anything; Date and Math.random() throw. ${HOSTED_WORKFLOW_TEXT_ONLY_AGENTS} Runs in the background by default: the run settles later and its result arrives as a notification input. With run_in_background false the call waits and returns the run result directly. Saved-workflow names, script paths, resume and nesting are unavailable in this profile: pass the complete script inline.`,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          'The complete workflow source, optionally starting with a literal `export const meta = {...}` whose name labels the run.',
      },
      args: {
        description:
          'Optional structured JSON value bound to the `args` global.',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'Run the workflow in the background and notify at completion (default true).',
      },
    },
    required: ['script'],
    additionalProperties: false,
  },
};
const SEND_MESSAGE_TEXT_SCHEMA = {
  type: 'string',
  description: 'The message text.',
  minLength: 1,
};

/**
 * H4d-b: a parent's durable message to one of its child agent tasks. A
 * running child takes it as its next input; a completed child is
 * continued as a new background run with the message as its instruction.
 */
export const HOSTED_SEND_MESSAGE_TO_CHILD_TOOL: FunctionDeclaration = {
  name: 'send_message',
  description:
    'Send a message to a child agent this Session launched, by the task_id its launch returned. A running child receives it as its next input once its current turn ends. A child that completed is continued as a new background task with your message as its next instruction, together with its earlier instructions and results; its result arrives as a notification like the first. A failed or cancelled child cannot receive messages. There is no inline reply: the child answers through its completion notification or by messaging you.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The task id the child agent launch returned.',
      },
      message: SEND_MESSAGE_TEXT_SCHEMA,
    },
    required: ['task_id', 'message'],
    additionalProperties: false,
  },
};

/** H4d-b: the answers of a committed send_message, which recovery repeats
 * for a call an interrupted turn committed but never answered. */
export const HOSTED_MESSAGE_TO_PARENT_TEXT =
  "Message queued for delivery to the parent agent. It arrives as the parent's next input once its current turn ends.";

export function hostedMessageToChildText(taskId: string): string {
  return `Message queued for delivery to child agent ${taskId}. It arrives as the child's next input once its current turn ends. There is no inline reply: the child answers through its completion notification or a message to you. Do not relaunch the task while waiting.`;
}

export function hostedMessageContinuedText(
  predecessorTaskId: string,
  taskId: string,
): string {
  return `Child agent ${predecessorTaskId} had completed; continued it as ${taskId} with your message as its next instruction. Its result arrives as a durable notification input; either task id reaches the newest run.`;
}

type HostedChildMessageRoute = Awaited<
  ReturnType<HostedChildAgentSession['sendToChild']>
>;
type HostedSentRoute = Exclude<HostedChildMessageRoute, { kind: 'refused' }>;

/**
 * H4e-b2: the continuation taken before this one never started, so its
 * work is asked for again unless this send carries it. A lost message is
 * asked for only when its own answer has not already done so.
 */
function previousNote(route: HostedSentRoute): string {
  const previous = route.previousNeverStarted;
  if (previous === undefined) return '';
  const carrier =
    route.ownNeverStarted === undefined
      ? 'this message'
      : 'your resend of this message';
  const action = previous.cancelled
    ? `send that work again only if it is still wanted and ${carrier} does not carry it`
    : `send that work again unless ${carrier} carries it`;
  const lost =
    previous.lostMessages === 0
      ? ''
      : ` ${lostMessagesAction(previous.lostMessages)}.`;
  return ` Its previous continuation ${neverStartedClause(previous)}; ${action}.${lost}`;
}

/**
 * The answer of one send, to a member by name or to a task id: a member
 * is named and its result labeled (H4e-b2 decisions 3 and 6), and a run
 * that never started is told, since a failed child sends no notification.
 * A replay or a recovered answer may find the run it reached proved since
 * that it never started.
 */
export function hostedRouteAnswer(
  children: HostedChildAgentSession,
  route: HostedSentRoute,
): string {
  const task = children.taskIdOf(route.childRunId);
  const member = route.member;
  const own = route.ownNeverStarted;
  if (own !== undefined) {
    const told =
      route.kind === 'message'
        ? `Message was queued for ${member === undefined ? `child agent ${task}` : `member "${member.name}" as task ${task}`}, which ${neverStartedPhrase(own)}, so this message did not arrive.`
        : `${member === undefined ? `Child agent ${children.taskIdOf(route.predecessorChildRunId)}` : `Member "${member.name}"`} had completed; continued it as task ${task}, which ${neverStartedPhrase(own)}, so this message did not arrive.`;
    // Each answer asks again only for its own message: what else that run
    // carried or lost belongs to its own calls' answers and to the next
    // send's note. A launch that never started ended its member or child.
    const resend =
      own.predecessorChildRunId !== null
        ? ` ${own.cancelled ? 'If it is still wanted, send it' : 'Send it'} again with send_message to ${member === undefined ? `task_id "${children.taskIdOf(own.predecessorChildRunId)}"` : `"${member.name}"`}.`
        : member === undefined
          ? ` That child agent has ended; ${own.cancelled ? 'if this work is still wanted, launch a new agent for it' : 'launch a new agent for this work'}.`
          : ` Member "${member.name}" has ended; ${own.cancelled ? 'if this work is still wanted, launch a new member under a new name for it' : 'for more work, launch a new member under a new name'}.`;
    return told + resend + previousNote(route);
  }
  if (route.deliveryUnconfirmed) {
    const recipient =
      member === undefined
        ? `child agent ${task}`
        : `member "${member.name}" (task ${task})`;
    const check =
      member === undefined ? 'the child agent' : `member "${member.name}"`;
    return `Message was queued for ${recipient}, but its delivery could not be confirmed. Check with ${check} before sending it again.`;
  }
  // A message whose delivery ended with no receipt did not arrive; what a
  // resend meets depends on the chain now.
  if (route.deliveryFailed !== undefined) {
    const { state, chain } = route.deliveryFailed;
    const told = `Message was queued for ${member === undefined ? `child agent ${task}` : `member "${member.name}" (task ${task})`}, but its delivery was ${state}, so it did not arrive.`;
    const address =
      member === undefined ? `task_id "${task}"` : `"${member.name}"`;
    if (chain === 'open')
      return `${told} Send it again with send_message to ${address} if it is still needed.`;
    if (chain === 'settling')
      return `${told} Its latest continuation is being stopped before it started; if that continuation ends without starting, send it again with send_message to ${address} if it is still needed.`;
    if (chain === 'stopping')
      return member === undefined
        ? `${told} That child agent is being stopped; launch a new agent for this work after it ends if it is still needed.`
        : `${told} Member "${member.name}" is being stopped; for more work after it ends, launch a new member under a new name.`;
    return member === undefined
      ? `${told} That child agent has ended; launch a new agent for this work if it is still needed.`
      : `${told} Member "${member.name}" has ended; for more work, launch a new member under a new name.`;
  }
  if (route.kind === 'message')
    return member === undefined
      ? hostedMessageToChildText(task)
      : `Message queued for delivery to member "${member.name}" (task ${task}). It arrives as its next input once its current turn ends. There is no inline reply: the member answers through its result notification or a message to you.`;
  return (
    (member === undefined
      ? hostedMessageContinuedText(
          children.taskIdOf(route.predecessorChildRunId),
          task,
        )
      : `Member "${member.name}" had completed; continued it as task ${task} with your message as its next instruction. Its result arrives labeled "${member.name}".`) +
    previousNote(route)
  );
}

/** Whether a committed send reached its recipient as far as is known. */
function hostedRouteArrived(route: HostedSentRoute): boolean {
  return (
    route.ownNeverStarted === undefined &&
    route.deliveryFailed === undefined &&
    !route.deliveryUnconfirmed
  );
}

function hostedRouteUnconfirmed(route: HostedSentRoute): boolean {
  return route.deliveryUnconfirmed === true;
}

/** H4e-b2: one broadcast recipient's line in the call's answer. */
function hostedRouteLine(
  children: HostedChildAgentSession,
  route: HostedChildMessageRoute,
): string {
  if (route.kind === 'refused') return `not reached: ${route.reason}`;
  const task = children.taskIdOf(route.childRunId);
  const own = route.ownNeverStarted;
  if (route.kind === 'message')
    return own !== undefined
      ? `queued for task ${task}, which ${neverStartedPhrase(own)}, so the message did not arrive.${route.member !== undefined && own.predecessorChildRunId === null ? ` Member "${route.member.name}" has ended and takes no messages.` : ''}`
      : route.deliveryUnconfirmed
        ? `queued for task ${task}, but its delivery could not be confirmed. Check with the member before sending it again.`
        : route.deliveryFailed !== undefined
          ? `queued for task ${task}, but its delivery was ${route.deliveryFailed.state}, so the message did not arrive.${route.deliveryFailed.chain === 'ended' ? ' It has ended and takes no messages.' : route.deliveryFailed.chain === 'stopping' ? ' It is being stopped and takes no messages.' : ''}`
          : `queued for its running task ${task}.`;
  return (
    (own === undefined
      ? `had completed; continued as task ${task}.`
      : `had completed; continued as task ${task}, which ${neverStartedPhrase(own)}, so the message did not arrive.`) +
    previousNote(route)
  );
}

/** One recipient a broadcast call committed a send to. */
export interface HostedBroadcastRecipient {
  readonly position: number;
  /** The member name, while a team still lists the chain. */
  readonly name: string | undefined;
  /** The roster entry's run the recipient's chain started from. */
  readonly rootChildRunId: string;
  /** False when the run never started, delivery failed, or delivery is
   * unconfirmed. Mutually exclusive with `unconfirmed`. */
  readonly arrived: boolean;
  /** The message may have arrived, so it is neither arrived nor failed. */
  readonly unconfirmed: boolean;
  readonly text: string;
}

/**
 * H4e-b2 decision 9: what one broadcast call committed, recipient by
 * recipient, found under each position's ids. Recovery and the PostToolUse
 * dispatch evidence probe all positions whatever the journaled arguments
 * say, since a hook may have rewritten the input the call executed.
 */
export function hostedBroadcastCommitted(input: {
  readonly authority: {
    extensionRecordsInDomain(
      domain: ManagedSessionDomain,
    ): ReadonlyArray<{ readonly record: unknown }>;
  };
  readonly children: HostedChildAgentSession;
  readonly messages: HostedSessionMessageSession | undefined;
  readonly senderSessionId: string;
  readonly promptId: string;
  readonly callId: string;
}): HostedBroadcastRecipient[] {
  const chains = new HostedChildChains(
    input.authority.extensionRecordsInDomain('child_run'),
  );
  const teams = input.authority.extensionRecordsInDomain('team_state');
  const found: HostedBroadcastRecipient[] = [];
  for (let position = 1; position <= HOSTED_BROADCAST_POSITIONS; position++) {
    const message = input.messages?.message(
      broadcastMessageId({
        senderSessionId: input.senderSessionId,
        turnId: input.promptId,
        callId: input.callId,
        position,
      }),
    );
    const continued = input.children.record(
      broadcastRunId(input.promptId, input.callId, position),
    );
    let sent:
      | { kind: 'message'; childRunId: string; messageId: string }
      | {
          kind: 'continuation';
          childRunId: string;
          predecessorChildRunId: string;
        };
    if (message?.direction === 'outbound')
      sent = {
        kind: 'message',
        childRunId: message.childRunId,
        messageId: message.messageId,
      };
    else if (continued?.predecessorChildRunId)
      sent = {
        kind: 'continuation',
        childRunId: continued.childRunId,
        predecessorChildRunId: continued.predecessorChildRunId,
      };
    else continue;
    const route = {
      ...sent,
      ...hostedRouteDetails(
        input.authority,
        sent,
        sent.kind === 'message' ? sent.messageId : undefined,
        chains,
      ),
    };
    const rootChildRunId = chains.root(route.childRunId);
    found.push({
      position,
      name: hostedTeamMembership(teams, rootChildRunId)?.name,
      rootChildRunId,
      arrived: hostedRouteArrived(route),
      unconfirmed: hostedRouteUnconfirmed(route),
      text: hostedRouteLine(input.children, route),
    });
  }
  return found;
}

/**
 * Whether one call committed any broadcast recipient: the same ids as
 * `hostedBroadcastCommitted`, probed without indexing the lead's runs, so
 * the PostToolUse dispatch evidence stays cheap for every send.
 */
export function hostedBroadcastAnyCommitted(input: {
  readonly children: HostedChildAgentSession;
  readonly messages: HostedSessionMessageSession | undefined;
  readonly senderSessionId: string;
  readonly promptId: string;
  readonly callId: string;
}): boolean {
  for (let position = 1; position <= HOSTED_BROADCAST_POSITIONS; position++) {
    if (
      input.messages?.message(
        broadcastMessageId({
          senderSessionId: input.senderSessionId,
          turnId: input.promptId,
          callId: input.callId,
          position,
        }),
      )?.direction === 'outbound' ||
      input.children.record(
        broadcastRunId(input.promptId, input.callId, position),
      )?.predecessorChildRunId
    )
      return true;
  }
  return false;
}

/**
 * H4e-b2: the same tool beside the team tools, which also addresses a
 * member by name and every member at once (decisions 3 and 4).
 */
export const HOSTED_TEAM_SEND_MESSAGE_TO_CHILD_TOOL: FunctionDeclaration = {
  name: 'send_message',
  description:
    'Send a message to a member of your team by name (to), to every member at once (to: "*"), or to a child agent this Session launched by the task_id its launch returned; give exactly one of to and task_id. A running member or child receives it as its next input once its current turn ends. One that completed is continued as a new background task with your message as its next instruction, together with its earlier instructions and results; its result arrives as a notification, and a member\'s result is labeled with its name. A failed, cancelled or stopping one, or one that completed after a stop was requested, cannot receive messages. There is no inline reply: the recipient answers through its result notification or by messaging you. A message is not a board change: record the work with task_update in the same turn.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'A member name of your team, or "*" for every member. Use task_id instead for a child agent that is not a member.',
      },
      task_id: {
        type: 'string',
        description: 'The task id a child agent launch returned.',
      },
      message: SEND_MESSAGE_TEXT_SCHEMA,
    },
    required: ['message'],
    additionalProperties: false,
  },
};

/** H4e-b2 decision 4: `to` names every member at once. */
function isBroadcast(to: unknown): boolean {
  return typeof to === 'string' && to.trim() === '*';
}

/**
 * H4e-b2 decision 4: the team form's input with its recipients first. The
 * approval card previews only the input's first 8 KiB, so a long message
 * must never push `to` or `task_id` out of it.
 */
export function hostedTeamMessageInput(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(args['to'] === undefined ? {} : { to: args['to'] }),
    ...(args['task_id'] === undefined ? {} : { task_id: args['task_id'] }),
    ...args,
  };
}

/** H4d-b: a child Session's durable message to the parent that launched it. */
export const HOSTED_SEND_MESSAGE_TO_PARENT_TOOL: FunctionDeclaration = {
  name: 'send_message',
  description:
    "Send a message to the parent agent that launched this Session, for a question or progress it needs before you finish. It arrives as the parent's next input once the parent's current turn ends. Your final answer still reaches the parent as your result, so do not repeat it here.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        enum: ['parent'],
        description: 'The recipient: always "parent".',
      },
      message: SEND_MESSAGE_TEXT_SCHEMA,
    },
    required: ['to', 'message'],
    additionalProperties: false,
  },
};

/**
 * H4e-b3 decision 8 (b3c): a member's send_message names `"parent"`,
 * another member, or `"*"`; member-addressed sends are commands to the
 * leader, and only the leader takes the plain message. Declared beside
 * the board commands, on the same gate (a lineage Session whose run's
 * first input carries the member preamble).
 */
export const HOSTED_MEMBER_SEND_MESSAGE_TOOL: FunctionDeclaration = {
  name: 'send_message',
  description:
    'Send a message to another member of your team by name, to every other member at once (to: "*"), or to the team leader (to: "parent"). Member messages travel through the leader, which answers with each recipient\'s outcome; a running member receives the message as its next input once its current turn ends, and a member that has finished, ended or is being stopped is not reached. There is no inline reply: the recipient answers you with send_message naming you, and the leader\'s reply arrives as your next instruction. A message is not a board change: record work with the task tools.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'A member name, "*" for every other member, or "parent" for the team leader.',
      },
      message: SEND_MESSAGE_TEXT_SCHEMA,
    },
    required: ['to', 'message'],
    additionalProperties: false,
  },
};

/**
 * H4e-b3 decision 6: a member's board read, as a `board_read` command to
 * its leader. The schema mirrors the lead's `task_list` exactly.
 */
export const HOSTED_MEMBER_TASK_LIST_TOOL: FunctionDeclaration = {
  name: 'task_list',
  description:
    'List your team board, optionally filtered, followed by each member with the state of its current run — the board and the roster as your leader holds them. Board changes are not pushed to you: read the board again when you need the current state.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'Filter by task status.',
      },
      owner: {
        type: 'string',
        description: 'Filter by owner name.',
      },
      blockedBy: {
        type: 'string',
        description: 'Filter for tasks still blocked by this task number.',
      },
    },
    additionalProperties: false,
  },
};

/** H4e-b3 decision 6: a member's task creation, as a `board_write` command. */
export const HOSTED_MEMBER_TASK_CREATE_TOOL: FunctionDeclaration = {
  name: 'task_create',
  description:
    'Create a pending task on your team board. The leader records it and answers with the new task number. Members are not told about board changes: put new work for another member in your final answer, or ask the leader to hand it out.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        maxLength: SUBJECT_CHARS,
        description: 'Short title for the task.',
      },
      description: {
        type: 'string',
        maxLength: DESCRIPTION_CHARS,
        description: 'Detailed description of the task.',
      },
      activeForm: {
        type: 'string',
        maxLength: ACTIVE_FORM_CHARS,
        description: 'Present tense label for UI (e.g., "Running tests").',
      },
      metadata: {
        type: 'object',
        description: 'Optional arbitrary metadata.',
      },
    },
    required: ['subject', 'description'],
    additionalProperties: false,
  },
};

/** H4e-b3 decision 6: a member's task revision, as a `board_write` command. */
export const HOSTED_MEMBER_TASK_UPDATE_TOOL: FunctionDeclaration = {
  name: 'task_update',
  description:
    'Update a board task: status, owner, subject, description, active form, metadata or dependencies; set status to "deleted" to remove it. Status, owner, subject and description change only on a task you own or that has no owner, and edges only reach such tasks; activeForm and metadata change on any task; owner may be only your own name or "" to unassign, and moving an unowned task to in_progress makes you its owner. A task in progress needs an owner. The answer is the revised task, or the refusal.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Number of the task to update, as "3" or "#3".',
      },
      status: {
        type: 'string',
        enum: TASK_STATUSES,
        description: 'New task status.',
      },
      owner: {
        type: 'string',
        description:
          'New owner: your own name, or an empty string to unassign.',
      },
      subject: {
        type: 'string',
        maxLength: SUBJECT_CHARS,
        description: 'Updated task title.',
      },
      description: {
        type: 'string',
        maxLength: DESCRIPTION_CHARS,
        description: 'Updated task description.',
      },
      activeForm: {
        type: 'string',
        maxLength: ACTIVE_FORM_CHARS,
        description: 'Present tense label for UI.',
      },
      metadata: {
        type: 'object',
        description: 'Metadata to merge. Set a key to null to delete it.',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Numbers of the tasks this task blocks.',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Numbers of the tasks that block this task.',
      },
    },
    required: ['taskId'],
    additionalProperties: false,
  },
};

export const HOSTED_MEMBER_BOARD_TOOLS: readonly FunctionDeclaration[] = [
  HOSTED_MEMBER_TASK_LIST_TOOL,
  HOSTED_MEMBER_TASK_CREATE_TOOL,
  HOSTED_MEMBER_TASK_UPDATE_TOOL,
];

export const HOSTED_MEMBER_COMMAND_TOOL_NAMES: readonly string[] =
  HOSTED_MEMBER_BOARD_TOOLS.map((tool) => tool.name!);

/**
 * H4e-b1: the agent tool of a Session whose team tools are declared. With
 * `name`, the child is a member of the Session's active team.
 */
export const HOSTED_TEAM_AGENT_TOOL: FunctionDeclaration = {
  ...HOSTED_AGENT_TOOL,
  description:
    HOSTED_AGENT_TOOL.description +
    " With name, the child joins this Session's active team as a member: it runs in the background, its result arrives labeled with its name, and it keeps its place on the roster after it ends.",
  parametersJsonSchema: {
    ...(HOSTED_AGENT_TOOL.parametersJsonSchema as Record<string, unknown>),
    properties: {
      ...(
        HOSTED_AGENT_TOOL.parametersJsonSchema as {
          properties: Record<string, unknown>;
        }
      ).properties,
      name: {
        type: 'string',
        description:
          'Launch the child as a member of the active team under this name (team_create first). A member always runs in the background.',
      },
    },
  },
};

/**
 * #13753 I2: an Agent tool declaration with `isolation`, the legacy Agent
 * tool's name and value, for a host that serves child Workspaces. Only
 * there does the model see it; elsewhere each declaration stays exactly
 * as it was.
 */
function withWorktreeIsolation(tool: FunctionDeclaration): FunctionDeclaration {
  const schema = tool.parametersJsonSchema as {
    properties: Record<string, unknown>;
  };
  return {
    ...tool,
    description:
      tool.description!.replace(
        'Nesting, custom subagent types and isolated workspaces are unavailable in this profile.',
        'Nesting and custom subagent types are unavailable in this profile.',
      ) +
      ' With isolation "worktree" the child works in its own Git worktree of this Workspace\'s repository: its changes merge back into this Workspace as uncommitted changes when it completes, before its result arrives, and the result reports the merge (merged, conflicted with its paths, or blocked); a failed or cancelled child\'s worktree is discarded.',
    parametersJsonSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description:
            'Run the child in its own Git worktree that merges back when it completes. Omit to share this Workspace directly.',
        },
      },
    },
  };
}

export const HOSTED_AGENT_WORKTREE_TOOL =
  withWorktreeIsolation(HOSTED_AGENT_TOOL);
export const HOSTED_TEAM_AGENT_WORKTREE_TOOL = withWorktreeIsolation(
  HOSTED_TEAM_AGENT_TOOL,
);

function physicalToolStatus(
  response: Record<string, unknown> | undefined,
): 'success' | 'error' | 'cancelled' {
  if (response?.['executionStatus'] !== undefined)
    return response['executionStatus'] === 'success'
      ? 'success'
      : response['executionStatus'] === 'cancelled'
        ? 'cancelled'
        : 'error';
  return response?.['error'] ? 'error' : 'success';
}

export { hostedRuntimeSessionId } from './hosted-workspace-broker.js';

export class HostedToolRecoveryRequiredError extends Error {
  constructor(cause: unknown) {
    super(
      'Hosted tool turn requires recovery; its original work was not released.',
      { cause },
    );
  }
}

/**
 * The abandoned-wait answer's exact text, shared by every arm that can
 * write it: the live wait's abort branch, the continue route's resume arm
 * and the cancel route's settlement. One durable story of one situation.
 */
export const HOSTED_AGENT_WAIT_ABANDONED_TEXT =
  'The turn was cancelled before the child agent finished; the child keeps running and its committed result is retained.';

/**
 * The never-admitted answer for a sibling call the dead batch never
 * reached: the live admission's own wording, also what the cancel
 * route's settlement writes for the parked round's remaining agent
 * calls.
 */
export const HOSTED_AGENT_CALL_NOT_ADMITTED_TEXT =
  'The turn was cancelled before this child agent was admitted.';

/**
 * The same never-admitted answer phrased for the recovery family — the
 * continue route's gap fill and the interrupted-turn funnel, where
 * nothing was cancelled: the answer must be honest about there being no
 * ledger record without asserting a cause that never happened.
 */
export const HOSTED_AGENT_CALL_NOT_REACHED_TEXT =
  'The owning turn was interrupted before this child agent was admitted; the call never ran.';

/**
 * Which of this Turn's tool_result parts are already durable — the
 * exactly-once predicate every replayed fold rides (never the process):
 * keyed on the functionResponse id, so a replay skips only the commit
 * while the replays-safe marks still run. Pass `projected` when the
 * caller already holds the same journal projection: one authority for
 * the predicate, no second walk of every committed event.
 */
export async function journaledToolResultIds(
  session: ManagedSession,
  promptId: string,
  projected?: Awaited<ReturnType<ManagedSession['sink']['project']>>,
): Promise<Set<string>> {
  const records = projected ?? (await session.sink.project());
  return new Set(
    records
      .filter(
        (entry) =>
          entry.daemonPromptId === promptId && entry.type === 'tool_result',
      )
      .flatMap((entry) => entry.message?.parts ?? [])
      .map((part) => part.functionResponse?.id)
      .filter((id): id is string => typeof id === 'string'),
  );
}

/**
 * The one derivation of the child run id shared by the launcher, the
 * recovery probe and the gap fill: a wake turn's turn id already embeds
 * its commissioning child run (`<childRunId>:accept:notify`), so using it
 * verbatim as the launch base grows the next run id one suffix per hop
 * and walks a chained helper into the 128-char lineage bound by the
 * third hop. The replay-stable key needs determinism, not readability:
 * collapse the wake turn's identity to a bounded digest of its own
 * stable name — never grow across hops, always 17 chars plus the call
 * id. Calls keyed verbatim for every other turn — re-driven batches and
 * resumed Hook results both name the same run again and again.
 */
export function hostedChildRunIdFor(promptId: string, callId: string): string {
  return hostedCallKey(promptId, callId);
}

/** H4e-b1: what a member's started answer adds once its join committed. */
export function hostedTeamJoinedText(member: {
  readonly teamName: string;
  readonly name: string;
}): string {
  return ` It joined team "${member.teamName}" as "${member.name}", and its result arrives labeled with that name.`;
}

/**
 * The live background arm's started receipt, shared with the recovery
 * gap fill's background-orphan branch: one sentence naming the child's
 * kind, the task the model should track and exactly how results land on
 * it.
 */
export function hostedChildBackgroundStartedText(
  kind: 'child_agent' | 'workflow',
  taskId: string,
): string {
  return `${childKindLabel(kind)} started in the background as ${taskId}; the task surface stays current with it. A completed child delivers its result as a durable notification input; a failed or cancelled child produces no notification — read the task surface instead of waiting.`;
}

/**
 * The inline-fit truncation shared by the live wait arm and the
 * recovery gap fill (R3-2): fit the whole fold when the record the fold
 * actually writes fits, else halve the text until the marker lands
 * whole. One marker, one halving rule, one error — `fits` must measure
 * exactly the record the caller will write, never an estimate.
 */
export function fitChildResultInline(
  name: string,
  callId: string,
  text: string,
  fits: (parts: Part[]) => boolean,
  /** Kept whole after the result, folded or not (#13753 I2). */
  suffix = '',
): Part[] {
  const whole = convertToFunctionResponse(name, callId, [
    { text: text + suffix },
  ]);
  if (fits(whole)) return whole;
  const marker = '\n… (truncated: the full result is on the acceptance record)';
  for (
    let head = Math.floor(text.length / 2);
    head > 0;
    head = Math.floor(head / 2)
  ) {
    const folded = convertToFunctionResponse(name, callId, [
      { text: text.slice(0, head) + marker + suffix },
    ]);
    if (fits(folded)) return folded;
  }
  throw new Error('Child agent result cannot be recorded inline.');
}

interface HostedEncodedToolInput {
  payloadJson: string;
  inputBytes: Buffer;
  digest: string;
}

/** The encoding of a refused call, which nothing downstream reads. */
const UNENCODED_TOOL_INPUT: HostedEncodedToolInput = Object.freeze({
  payloadJson: '',
  inputBytes: Buffer.alloc(0),
  digest: 'sha256:',
});

class HostedToolInputInlineLimitError extends Error {
  constructor() {
    super('Hosted tool input exceeds the inline Session Store limit.');
    this.name = 'HostedToolInputInlineLimitError';
  }
}

interface HostedPreparedRequest {
  call: ToolCallRequestInfo;
  validationError?: string;
  input: Record<string, unknown>;
  isShell: boolean;
  inputDigest?: string;
  mcp: boolean;
  payloadJson: string;
  inputBytes: Buffer;
  digest: string;
  /** Absent when the input exceeds the canonical-digest ceiling; the
   * call then carries its own validationError (#13803 D1). */
  argsDigest?: string;
  publicationId: string | null;
  runtimeCallId: string;
  background: boolean;
  monitoring: boolean;
  agent: boolean;
  workflow: boolean;
  agentBackground: boolean;
  team: boolean;
  message: boolean;
  command: boolean;
  skill: boolean;
}

export class HostedWorkspaceToolTurn {
  private logicalRound = 0;
  private nativeBatch?: {
    messageId: string;
    model: string;
    parts: Part[];
    requests: HostedPreparedRequest[];
    refusals: Array<string | undefined>;
    inputRefs: Map<number, ManagedSessionDurableRef>;
    definitionRefs: Map<number, ManagedSessionDurableRef>;
    actionIds: Map<number, string>;
    uncaptured?: boolean;
  };
  hookStopReason?: string;
  private readonly broker: HostedWorkspaceBroker;
  private readonly warmed: Promise<void>;
  private acquired = false;
  private cleanupOwed = false;
  private retiredOwnerResults = false;
  private uncertain = false;
  // Agent calls never write a `tool.intent` (the Broker pipeline they
  // bypass owns that marker), so completeHookResults needs the admitted
  // launches this turn recorded directly — it is how PostToolUse learns
  // an agent call actually ran (R1-62).
  private readonly agentDispatched = new Set<string>();
  private publisher?: HostedShellPublisher;
  private bindingGeneration?: string;
  private advertised?: FunctionDeclaration[];
  private readonly publication?: {
    owner: HttpToolPublicationOwner;
    captureBytes: number;
  };
  private readonly shell?: HostedShellTurnOptions;
  // Once an approval expires nobody is answering, so the Turn asks no more.
  private unanswered = false;
  private promptHookRunner?: HostedPromptHookRunner;
  private readonly hookPermission = new Map<string, 'allow' | 'deny'>();
  private readonly mcp?: HostedMcpSession;
  private readonly hooks?: HostedHookSession;
  private readonly profile?: string;
  private readonly context?: HostedWorkspaceContextSlot;
  private readonly childRuns?: HostedChildRunSession;
  private readonly monitors?: HostedMonitorSession;
  private readonly backgroundLane?: HostedShellTurnOptions;
  private readonly childAgents?: HostedChildAgentSession;
  private readonly childDepth: number;
  private readonly childWorkspaces: boolean;
  private readonly childConsumption: (childRunId: string) => void;
  private readonly messages?: HostedSessionMessageSession;
  private readonly teams?: HostedTeamSession;
  /** H4e-b3: the member's command funnel to its parent, beside its messages. */
  private readonly commands?: HostedSessionCommandSession;
  private readonly skills?: HostedSkillCatalog;
  /** b3b: whether this Session's run carries a member preamble (once read). */
  private memberPreamble?: boolean;
  /** b3b: the member board vocabulary declared, refreshed per declarations. */
  private readonly commandToolNames = new Set<string>();
  /** b3b decision 4: batches of this Turn whose command park committed. */
  private readonly commandParks = new Set<string>();
  /** b3b decision 4: a command call of this Turn timed out (decision 4's lock). */
  private commandTimedOut = false;
  /**
   * H4e-b3 decisions 5/9: this run's first input carried an unescaped
   * `plan-mode="required"` preamble (assembly read it off the journal).
   */
  private readonly memberPlanMode: boolean;

  constructor(
    private readonly options: HostedWorkspaceBrokerOptions,
    private readonly session: ManagedSession,
    private readonly harness: ManagedHarnessHandle,
    private readonly promptId: string,
    private readonly commit: (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
      identity?: { uuid: string; timestamp: string },
    ) => Promise<string>,
    private readonly messageFitsInline: (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
    ) => boolean,
    publicationOrShell?:
      | { owner: HttpToolPublicationOwner; captureBytes: number }
      | HostedShellTurnOptions,
    shell?: HostedShellTurnOptions,
    private readonly approval?: HostedApprovalTurnOptions,
    // The trailing optional dependencies travel as one named bag: at five
    // positional slots a dropped or mis-ordered argument still typechecks
    // (R1-2/R1-3 were exactly that), while a missing object field is named
    // at every call site.
    extras?: {
      mcp?: HostedMcpSession;
      hooks?: HostedHookSession;
      profile?: string;
      context?: HostedWorkspaceContextSlot;
      childRuns?: HostedChildRunSession;
      monitors?: HostedMonitorSession;
      backgroundLane?: HostedShellTurnOptions;
      childAgents?: {
        readonly funnel: HostedChildAgentSession;
        readonly depth: number;
        /** #13753 I2: the host serves child Workspaces. */
        readonly childWorkspaces?: boolean;
        readonly queueConsumption: (childRunId: string) => void;
      };
      messages?: HostedSessionMessageSession;
      teams?: HostedTeamSession;
      commands?: HostedSessionCommandSession;
      skills?: HostedSkillCatalog;
      /**
       * H4e-b3 decisions 5/9: this run's first input carried an unescaped
       * `plan-mode="required"` preamble; its calls admit reads only.
       */
      memberPlanMode?: boolean;
    },
  ) {
    this.mcp = extras?.mcp;
    this.hooks = extras?.hooks;
    this.profile = extras?.profile;
    this.context = extras?.context;
    this.childRuns = extras?.childRuns;
    this.monitors = extras?.monitors;
    this.backgroundLane = extras?.backgroundLane;
    this.childAgents = extras?.childAgents?.funnel;
    this.childDepth = extras?.childAgents?.depth ?? 0;
    this.childWorkspaces = extras?.childAgents?.childWorkspaces === true;
    this.childConsumption =
      extras?.childAgents?.queueConsumption ?? (() => undefined);
    this.messages = extras?.messages;
    this.teams = extras?.teams;
    this.commands = extras?.commands;
    this.skills = extras?.skills;
    this.memberPlanMode = extras?.memberPlanMode === true;
    this.publication =
      publicationOrShell && 'owner' in publicationOrShell
        ? publicationOrShell
        : undefined;
    this.shell =
      publicationOrShell && 'resources' in publicationOrShell
        ? publicationOrShell
        : shell;
    this.broker =
      this.mcp?.broker ??
      this.hooks?.broker ??
      new HostedWorkspaceBroker(
        options,
        session.authority.sessionHeader.sessionKey,
        hostedRuntimeSessionId(promptId),
      );
    this.warmed = this.mcp ? this.mcp.ensureReady() : this.broker.warm();
    // Warmup runs alongside inference; a text-only answer need not wait for it.
    void this.warmed.catch(() => undefined);
  }

  /** Whether this Session runs one of the `/2` search profiles. */
  private get searchProfile(): boolean {
    return isHostedWorkspaceSearchProfile(this.profile);
  }

  /**
   * H4b: an Agent call is admitted exactly when this Shell-laned Session
   * owns its child orchestrator (a child Session's own turn does not),
   * behind the kind gate.
   */
  private agentsAdmitted(): boolean {
    return (
      this.childAgents !== undefined &&
      (this.shell !== undefined || this.backgroundLane !== undefined) &&
      this.childDepth === 0 &&
      childAgentAdmissionsEnabled()
    );
  }

  /** H4e-b1: the lead's team tools ride exactly where the Agent tool does. */
  private teamsAdmitted(): boolean {
    return (
      this.teams !== undefined &&
      this.agentsAdmitted() &&
      teamAdmissionsEnabled()
    );
  }

  async declarations(signal: AbortSignal): Promise<FunctionDeclaration[]> {
    signal.throwIfAborted();
    if (this.mcp) await waitForTurn(this.mcp.refresh(signal), signal);
    const search = isHostedWorkspaceSearchProfile(this.profile);
    // b3c: a member's widened send_message rides the same gate as its
    // board commands — resolved once, both declarations follow it.
    const memberCommands = await this.memberCommandsDeclared();
    const skill = this.skills?.declaration();
    this.advertised = [
      ...(this.publication || this.shell
        ? search
          ? HOSTED_WORKSPACE_SHELL_TOOLS_V2
          : HOSTED_WORKSPACE_SHELL_TOOLS
        : search
          ? HOSTED_WORKSPACE_FILE_TOOLS_V2
          : HOSTED_WORKSPACE_FILE_TOOLS
      ).map((tool) =>
        ['write_file', 'edit'].includes(tool.name ?? '')
          ? {
              ...tool,
              description:
                tool.description +
                (this.mcp
                  ? ' This MCP profile provides no file backups or undo for Write/Edit.'
                  : ' Write/Edit preimages are backed up. External or Shell changes to tracked content or permissions block further Write/Edit in the same prompt and block undo. A new Write/Edit prompt must validate a fresh backup before accepting those changes.'),
            }
          : tool,
      ),
      ...(this.mcp?.tools() ?? []),
      ...(skill ? [skill] : []),
      // H4b: the Agent tool joins the declaration set only on a
      // Shell-laned Session whose own child orchestrator exists (never in
      // a child's), behind the kind gate — files profiles and the public
      // files/1 flow keep their exact current vocabulary, mirrored by the
      // admission check in prepareRequests. H4e-b1's team tools follow it.
      // #13753 I2: only a host that serves child Workspaces sees isolation.
      ...(this.teamsAdmitted()
        ? [
            this.childWorkspaces
              ? HOSTED_TEAM_AGENT_WORKTREE_TOOL
              : HOSTED_TEAM_AGENT_TOOL,
            ...HOSTED_TEAM_TOOLS,
            ...(teamPlanAdmissionsEnabled() ? [HOSTED_TEAM_PLAN_TOOL] : []),
          ]
        : this.agentsAdmitted()
          ? [
              this.childWorkspaces
                ? HOSTED_AGENT_WORKTREE_TOOL
                : HOSTED_AGENT_TOOL,
            ]
          : []),
      // H4d-b: the same Sessions message along their lineage — a parent
      // to the child tasks it launched, a child to its own parent.
      ...(this.sendMessageRole() === 'parent'
        ? [
            this.teamsAdmitted()
              ? HOSTED_TEAM_SEND_MESSAGE_TO_CHILD_TOOL
              : HOSTED_SEND_MESSAGE_TO_CHILD_TOOL,
          ]
        : this.sendMessageRole() === 'child'
          ? [
              memberCommands
                ? HOSTED_MEMBER_SEND_MESSAGE_TOOL
                : HOSTED_SEND_MESSAGE_TO_PARENT_TOOL,
            ]
          : []),
      // #13803: the Workflow tool joins under the exact gate shape of the
      // Agent tool, behind its own kind reader — a child Session neither
      // advertises it nor may admit it (#13803 decision 5).
      ...(this.childAgents !== undefined &&
      (this.shell !== undefined || this.backgroundLane !== undefined) &&
      this.childDepth === 0 &&
      childWorkflowAdmissionsEnabled()
        ? [HOSTED_WORKFLOW_TOOL]
        : []),
    ];
    // H4e-b3: a member's board tools are its commands to the leader,
    // declared only on a lineage Session whose run's first input carries
    // its member preamble (decision 5) — a convenience beside the lead's
    // own admission of every command.
    this.commandToolNames.clear();
    if (memberCommands) {
      this.advertised.push(...HOSTED_MEMBER_BOARD_TOOLS);
      for (const tool of HOSTED_MEMBER_BOARD_TOOLS)
        if (tool.name !== undefined) this.commandToolNames.add(tool.name);
      if (this.memberPlanMode && teamPlanAdmissionsEnabled()) {
        this.advertised.push(HOSTED_MEMBER_PLAN_TOOL);
        this.commandToolNames.add('exit_plan_mode');
      }
    }
    if (this.teamsAdmitted() && teamPlanAdmissionsEnabled()) {
      this.advertised = this.advertised.map((tool) =>
        tool.name === 'agent'
          ? {
              ...tool,
              parametersJsonSchema: {
                ...(tool.parametersJsonSchema as Record<string, unknown>),
                properties: {
                  ...((tool.parametersJsonSchema as Record<string, unknown>)[
                    'properties'
                  ] as Record<string, unknown>),
                  plan_mode_required: {
                    type: 'boolean',
                    description:
                      'Require this named member to submit a plan before editing.',
                  },
                },
              },
            }
          : tool,
      );
    }
    return this.advertised;
  }

  /** Which side of its lineage this Session's send_message addresses. */
  private sendMessageRole(): 'parent' | 'child' | undefined {
    if (
      this.messages === undefined ||
      (this.shell === undefined && this.backgroundLane === undefined) ||
      !sessionMessageAdmissionsEnabled()
    )
      return undefined;
    if (this.messages.lineage !== undefined) return 'child';
    return this.childDepth === 0 && childAgentAdmissionsEnabled()
      ? 'parent'
      : undefined;
  }

  /**
   * b3b decision 5: the member board tools ride the command channel, and
   * only a lineage Session whose run's first input opens with a
   * well-formed member preamble declares them.
   */
  private async memberCommandsDeclared(): Promise<boolean> {
    if (this.commands?.lineage === undefined) return false;
    if (!sessionCommandAdmissionsEnabled()) return false;
    this.memberPreamble ??= await this.firstInputHasMemberPreamble();
    // b3c: the widened send_message needs the member's own name for its
    // local refusals, read off the same preamble.
    if (this.memberPreamble) await this.resolveMemberIdentity();
    return this.memberPreamble;
  }

  /** b3c/R1-10: the one read of the first input per Turn, cached. */
  private firstInputTextCache?: string | null;

  /**
   * The text of this Session's first accepted input, if readable: the
   * admission committers write the launch envelope as an OpenAI
   * message-content array; a plain {text} envelope rides the same gate
   * for the test-path fixtures. One read per Turn via the shared reader
   * (decision 8); anything unreadable hides the tools — it never grants.
   */
  private async firstInputText(): Promise<string | undefined> {
    if (this.firstInputTextCache !== undefined)
      return this.firstInputTextCache === null
        ? undefined
        : this.firstInputTextCache;
    let text: string | undefined;
    try {
      text = await hostedFirstInputText({
        authority: this.session.authority,
        resources: this.session.resources,
      });
    } catch {
      text = undefined;
    }
    this.firstInputTextCache = text ?? null;
    return text ?? undefined;
  }

  /**
   * The member marker (decision 5): this Session's own first accepted
   * input's text, checked for the run's preamble block. Anything
   * unreadable hides the tools — it never grants them.
   */
  private async firstInputHasMemberPreamble(): Promise<boolean> {
    const text = await this.firstInputText();
    return text === undefined ? false : firstInputOpensWithMemberPreamble(text);
  }

  /** b3c: who this run's preamble says the Session's member is, cached. */
  private memberIdentity?: { name: string; team: string } | null;
  private async resolveMemberIdentity(): Promise<{
    readonly name: string;
    readonly team: string;
  } | null> {
    if (this.memberIdentity === undefined) {
      const text = await this.firstInputText();
      this.memberIdentity =
        text === undefined ? null : (memberPreambleIdentity(text) ?? null);
    }
    return this.memberIdentity;
  }

  /**
   * H4e-b1's batch rules for a member launch: its name is a string, no
   * other launch in the batch takes the same name, and the batch neither
   * creates nor deletes the team the member joins nor waits on a
   * foreground child.
   */
  private memberBatchError(
    call: ToolCallRequestInfo,
    batch: readonly ToolCallRequestInfo[],
  ): string | undefined {
    const name = call.args['name'];
    if (typeof name !== 'string')
      return 'Hosted team member name must be a string.';
    if (
      batch.some(
        (other) => other.name === 'team_create' || other.name === 'team_delete',
      )
    )
      return 'Hosted team member cannot launch in the same batch as team_create or team_delete; let the team change land first.';
    if (
      batch.some(
        (other) =>
          other.name === 'send_message' && isBroadcast(other.args['to']),
      )
    )
      return 'Hosted team member cannot launch in the same batch as send_message to "*"; let the join land first.';
    // A recovered foreground wait (#13708) answers the batch's other
    // launches as plain background starts, which would hide the join.
    if (
      batch.some(
        (other) =>
          other.name === 'agent' &&
          (other.args['run_in_background'] === false ||
            (typeof other.args['run_in_background'] === 'string' &&
              other.args['run_in_background'].toLowerCase() === 'false')),
      )
    )
      return 'Hosted team member cannot launch in the same batch as a foreground child agent; launch it in its own batch.';
    if (
      batch.some(
        (other) =>
          other !== call &&
          other.name === 'agent' &&
          typeof other.args['name'] === 'string' &&
          sanitizeName(other.args['name']) === sanitizeName(name),
      )
    )
      return `Two launches in one batch name the member "${sanitizeName(name)}"; give each member its own name.`;
    return undefined;
  }

  // Result command Hooks can acquire after child admission and retain
  // the mount until Session close, so count their future hold as well.
  private sessionOwnerMayHoldMount(): boolean {
    return (
      (this.mcp?.mountHeld ?? false) ||
      (this.hooks?.mountHeld ?? false) ||
      (this.hooks?.hasMountableToolResultHooks ?? false)
    );
  }

  async resumeCommittedResults(signal?: AbortSignal): Promise<void> {
    if (this.acquired) return;
    if (this.skills && !this.hooks && !this.mcp) {
      const history = (await this.session.sink.project()).filter(
        (entry) => entry.daemonPromptId === this.promptId,
      );
      const calls = history.flatMap((entry) =>
        (entry.message?.parts ?? []).flatMap((part) =>
          part.functionCall ? [part.functionCall] : [],
        ),
      );
      const answered = await journaledToolResultIds(
        this.session,
        this.promptId,
        history,
      );
      if (
        calls.length &&
        calls.every((call) => call.name === 'skill' && answered.has(call.id!))
      )
        return;
    }
    await this.warmed;
    const saved = await readHostedFileHistory(this.session);
    if (saved?.pendingTurn) {
      this.uncertain = true;
      try {
        if (saved.pendingTurn !== this.promptId) {
          const ground: HostedFileHistorySettleBlocker =
            'pending_turn_mismatch';
          throw new Error(`Hosted file history requires recovery: ${ground}.`);
        }
        const settle = await canSettleHostedFileHistory(this.session, saved);
        if (settle !== null)
          throw new Error(
            `Hosted file history requires recovery: ${settle.blocker}${settle.detail === undefined ? '' : `: ${settle.detail}`}.`,
          );
        const authorization =
          await this.session.authority.harnessRunAuthorization();
        if (authorization.status !== 'runnable')
          throw new Error('Hosted file history requires recovery.');
        const owners = new Set<string>();
        for (const item of authorization.checkpoint.tools?.items ?? []) {
          if (
            item.modelMessageId !== saved.pendingMessageId ||
            !['write_file', 'edit'].includes(item.toolName)
          )
            continue;
          const intent = this.session.authority
            .eventsInSequenceRange(1, this.session.authority.committedSequence)
            .findLast(
              (event) =>
                event.kind === 'tool.intent' &&
                event.payload['executionCallId'] === item.executionCallId &&
                event.payload['batchId'] === saved.pendingMessageId,
            );
          const inputRef = assertManagedSessionDurableRef(
            intent?.payload['argsRef'],
            'file history tool input',
          );
          if (inputRef.kind !== 'managed-tool-input')
            throw new Error('Hosted file history owner conflicts.');
          const input = JSON.parse(
            (await this.session.resources.read(inputRef)).toString(),
          ) as { harnessSessionId: unknown; runtimeSessionId: unknown };
          if (
            input.harnessSessionId !==
              this.session.authority.sessionHeader.sessionKey.sessionId ||
            typeof input.runtimeSessionId !== 'string'
          )
            throw new Error('Hosted file history owner conflicts.');
          owners.add(
            assertManagedSessionStableId(
              input.runtimeSessionId,
              'file history Runtime owner',
            ),
          );
        }
        if (owners.size !== 1)
          throw new Error('Hosted file history owner conflicts.');
        const originalId = [...owners][0];
        const original =
          originalId === this.broker.runtimeSessionId
            ? this.broker
            : new HostedWorkspaceBroker(
                this.options,
                this.session.authority.sessionHeader.sessionKey,
                originalId,
              );
        await original.warm();
        if (
          original === this.broker &&
          !this.hooks &&
          !this.mcp &&
          !isHostedWorkspaceShellProfile(this.profile)
        ) {
          await oweHostedTurnCleanup(this.session, this.promptId, original);
          this.cleanupOwed = original.runtime !== undefined;
        }
        await original.acquire();
        const state = await original.fileHistory({
          kind: 'raw-file-history',
          action: 'snapshot',
        });
        if (!isDeepStrictEqual(state.snapshots, saved.state.snapshots))
          throw new Error('Original file history snapshots changed.');
        await commitHostedFileHistory(this.session, {
          schemaVersion: 1,
          state,
          pendingTurn: null,
          pendingUndo: null,
        });
        if (original === this.broker) {
          this.acquired = true;
          this.uncertain = false;
          // The acquire() path this bypasses is the context slot's writer: a
          // takeover-built Session holds no text yet, so read once here under
          // the same latch. A read failure never blocks the turn.
          if (this.context?.read() === undefined && signal)
            await this.fetchWorkspaceContext(signal);
          return;
        }
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      }
    }
    if (
      !saved?.pendingTurn &&
      !saved?.pendingUndo &&
      !this.hooks &&
      !this.mcp &&
      this.profile === HOSTED_WORKSPACE_FILE_PROFILE
    ) {
      this.uncertain = true;
      try {
        const authorization =
          await this.session.authority.harnessRunAuthorization();
        const items =
          authorization.status === 'runnable'
            ? authorization.checkpoint.tools?.items
            : undefined;
        if (
          authorization.status === 'runnable' &&
          authorization.checkpoint.identity.promptId === this.promptId &&
          authorization.checkpoint.continuation.phase === 'results_ready' &&
          items &&
          items.length > 0 &&
          items.every(
            (item) =>
              item.state === 'settled' &&
              ['read_file', 'write_file', 'edit', 'glob'].includes(
                item.toolName,
              ),
          ) &&
          (saved ||
            items.every((item) =>
              ['read_file', 'glob'].includes(item.toolName),
            )) &&
          (await canSettleHostedFileHistory(this.session, {
            pendingUndo: null,
            pendingTurn: this.promptId,
            pendingMessageId: items.at(-1)!.modelMessageId,
          })) === null
        ) {
          for (const item of items)
            await this.session.resources.read(item.outcomeRef!);
          if (
            await confirmReplacedHostedTurnOwner(
              this.session,
              this.promptId,
              this.broker,
              this.options,
            )
          ) {
            this.retiredOwnerResults = true;
            this.cleanupOwed = true;
            this.uncertain = false;
            return;
          }
        }
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      }
    }
    await this.acquire(true, signal);
    this.uncertain = false;
  }

  private async acquire(
    recovering = false,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.retiredOwnerResults) {
      this.uncertain = false;
      throw new Error(
        'The original Runtime was retired. Submit remaining tool work in a new Turn.',
      );
    }
    this.uncertain = true;
    let waitAborted = false;
    try {
      let queued = false;
      for (;;) {
        try {
          if (this.hooks && !this.mcp) await this.hooks.acquire();
          else {
            if (
              !this.cleanupOwed &&
              !this.mcp &&
              !isHostedWorkspaceShellProfile(this.profile)
            )
              await oweHostedTurnCleanup(
                this.session,
                this.promptId,
                this.broker,
              );
            if (
              !this.mcp &&
              !this.hooks &&
              !isHostedWorkspaceShellProfile(this.profile) &&
              this.broker.runtime
            )
              this.cleanupOwed = true;
            await this.broker.acquire();
          }
          break;
        } catch (cause) {
          // A definite busy refusal before claiming storage means another
          // Session's tool turn holds the mount: the turn waits for that
          // holder to release instead of failing terminally. Only the
          // turn-execution path queues (it passes the turn's AbortSignal, so
          // cancellation and the prompt deadline still apply); recovery
          // acquisitions and the workspace_unavailable refusal keep the
          // fast, classified refusal. Recovery carries a signal too — it
          // bounds the Workspace context read — so `recovering`, not the
          // signal's presence, is what selects the queue.
          if (
            recovering ||
            signal === undefined ||
            !isBusyWorkspaceAcquisition(cause)
          )
            throw cause;
          if (!queued) {
            queued = true;
            writeStderrLineSafe(
              `qwen serve: Hosted Harness turn ${this.promptId} waits for the Workspace mount held by another Session.`,
            );
          }
          try {
            await waitForTurn(
              new Promise((resolve) =>
                setTimeout(resolve, ACQUIRE_BUSY_POLL_MS),
              ),
              signal,
            );
          } catch (waitCause) {
            // Every response so far was a definite refusal, so a cancelled
            // queue wait provably leaves nothing held or unknown — unlike an
            // ambiguous acquire failure, which keeps recovery blocking even
            // when the turn itself is being cancelled.
            waitAborted = true;
            throw waitCause;
          }
        }
      }
      this.acquired = true;
      if (!this.mcp) {
        const saved = await readHostedFileHistory(this.session);
        if (saved?.pendingUndo)
          throw new Error('Hosted file history requires recovery.');
        if (saved?.pendingTurn)
          throw new Error('Hosted file history requires recovery.');
        try {
          await this.broker.fileHistory({
            kind: 'raw-file-history',
            action: 'bind',
            state: saved?.state ?? null,
          });
        } catch (cause) {
          // A saved continuation still needs this original runtime ID.
          if (recovering || !isHostedFileHistoryRefusal(cause)) throw cause;
          if (!this.hooks) await this.broker.release();
          this.acquired = false;
          throw new HostedFileHistoryRefusedError(
            cause.reason ?? cause.message,
          );
        }
        // The Workspace is reachable exactly here, before the first dispatch:
        // read its project instructions once, so this turn's later requests
        // and every later turn start with them. A read failure never blocks
        // the tool turn it rode in on. The latch alone gates the read: a
        // recovered attachment whose slot is still undefined (a takeover
        // builds a fresh one) reads here too, while an attachment already
        // holding text never re-reads.
        if (this.context?.read() === undefined && signal)
          await this.fetchWorkspaceContext(signal);
      }
    } catch (cause) {
      if (
        (!this.acquired &&
          (isRetryableWorkspaceAcquisition(cause) || waitAborted)) ||
        cause instanceof HostedFileHistoryRefusedError
      ) {
        this.uncertain = false;
        throw cause;
      }
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  /**
   * Reads the Workspace's project instruction files through the acquired
   * Runtime and offers them to the Session's context slot. The read is a
   * Runtime control, not a tool execution: it reserves nothing in the
   * execution ledger, so a failure leaves nothing to cancel or recover.
   * Best-effort: any failure leaves the slot untouched and is logged, never
   * thrown into the turn.
   */
  private async fetchWorkspaceContext(signal: AbortSignal): Promise<void> {
    const slot = this.context;
    if (!slot) return;
    try {
      const files = await waitForTurn(this.broker.workspaceContext(), signal);
      // `''` means "the Workspace has none", so an aborted turn must not
      // latch it: the slot stays undefined and a later turn retries.
      if (signal.aborted) return;
      slot.write(
        files
          .map(({ name, text }) => ({ name, text: text.trim() }))
          .filter(({ text }) => text)
          .map(
            ({ name, text }) =>
              `--- Context from: ${name} ---\n${text}\n--- End of Context from: ${name} ---`,
          )
          .join('\n\n'),
      );
    } catch (cause) {
      writeStderrLineSafe(
        'qwen serve: Hosted Workspace context read failed: ' + String(cause),
      );
    }
  }

  async execute(
    calls: ToolCallRequestInfo[],
    parts: Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    if (!this.hooks) return this.executeNative(calls, parts, model, signal);
    const responses = await this.executeNative(calls, parts, model, signal);
    return this.completeHookResults(calls, responses, model, signal);
  }

  private async completeHookResults(
    calls: ToolCallRequestInfo[],
    responses: Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    if (!this.hooks) return responses;
    const contextParts: Part[] = [];
    const history = await this.session.sink.project();
    const assistant = history.findLast(
      (entry) =>
        entry.type === 'assistant' &&
        entry.daemonPromptId === this.promptId &&
        entry.message?.parts?.some(
          (part) => part.functionCall?.id === calls[0]?.callId,
        ),
    );
    const intents = this.session.authority
      .eventsInSequenceRange(1, this.session.authority.committedSequence)
      .filter(
        (entry) =>
          entry.kind === 'tool.intent' &&
          entry.payload['batchId'] === assistant?.uuid,
      );
    const preToolOutputs = new Map<string, PreToolUseHookOutput>();
    const effective = await Promise.all(
      calls.map(async (call) => {
        const marker = this.session.authority.extensionRecord(
          'hook_execution',
          hostedHookOccurrenceId(
            HookEventName.PreToolUse,
            `${this.promptId}:${call.callId}`,
          ),
        );
        if (!marker) return call;
        const record = parseHookExecution(marker.record);
        const original = JSON.parse(
          (await this.session.resources.read(record.inputRef)).toString(),
        ) as { tool_input?: Record<string, unknown> };
        const saved = record.resultRef
          ? (JSON.parse(
              (await this.session.resources.read(record.resultRef)).toString(),
            ) as { output?: HookOutput })
          : undefined;
        if (saved?.output)
          preToolOutputs.set(
            call.callId,
            new PreToolUseHookOutput(saved.output),
          );
        return {
          ...call,
          args:
            (saved?.output?.hookSpecificOutput?.['updatedInput'] as
              | Record<string, unknown>
              | undefined) ??
            original.tool_input ??
            call.args,
        };
      }),
    );
    for (const [ordinal, call] of effective.entries()) {
      const response = responses.find(
        (part) => part.functionResponse?.id === call.callId,
      )?.functionResponse?.response;
      const dispatched =
        this.agentDispatched.has(call.callId) ||
        // A resumed committed result never re-drives the launch, so the
        // durable child_run record is the dispatch evidence that
        // survives restart: it exists exactly because the admission
        // committed (R1-62's recovery arm). The run id derives from the
        // same collapsed key the launcher wrote — a wake turn's id would
        // otherwise read as a hybrid between the two before the third hop.
        this.childAgents?.record(this.childRunIdFor(call.callId)) !==
          undefined ||
        this.messages?.message(this.messageIdFor(call.callId)) !== undefined ||
        // H4e-b2: a broadcast's recipients commit under their own ids.
        (call.name === 'send_message' &&
          this.childAgents !== undefined &&
          hostedBroadcastAnyCommitted({
            children: this.childAgents,
            messages: this.messages,
            senderSessionId:
              this.session.authority.sessionHeader.sessionKey.sessionId,
            promptId: this.promptId,
            callId: call.callId,
          })) ||
        intents.some((entry) => entry.payload['ordinal'] === ordinal) ||
        // A team tool commits only to the journal and answers a refusal as
        // its error, so its committed answer is its own dispatch evidence.
        (((call.name === 'skill' && this.skills !== undefined) ||
          HOSTED_TEAM_TOOL_NAMES.includes(call.name) ||
          (call.name === 'exit_plan_mode' &&
            this.commands?.command(
              sessionCommandId({
                senderSessionId:
                  this.session.authority.sessionHeader.sessionKey.sessionId,
                promptKey: hostedPromptKey(this.promptId),
                callId: call.callId,
              }),
            )?.kind === 'plan_submit') ||
          (call.name === 'team_plan_approval' &&
            teamPlanAdmissionsEnabled())) &&
          physicalToolStatus(response) === 'success');
      const preToolOutput = preToolOutputs.get(call.callId);
      const beforeContext = preToolOutput?.getAdditionalContext();
      if (
        beforeContext &&
        response?.['executionStatus'] !== 'cancelled' &&
        (!preToolOutput?.isAsk() || dispatched)
      )
        contextParts.push({ text: beforeContext });
      if (!dispatched) continue;
      if (response?.['executionStatus'] === 'not_started') continue;
      const failed = physicalToolStatus(response) !== 'success';
      const result = await this.hooks.fire(
        failed ? HookEventName.PostToolUseFailure : HookEventName.PostToolUse,
        `${this.promptId}:${call.callId}`,
        {
          tool_name: call.name,
          tool_input: call.args,
          tool_use_id: call.callId,
          ...(failed
            ? {
                error: String(
                  response?.['error'] ??
                    response?.['executionStatus'] ??
                    'Tool failed',
                ),
                is_interrupt: response?.['executionStatus'] === 'cancelled',
              }
            : { tool_response: response }),
          permission_mode: this.approval?.settings.mode ?? 'yolo',
          prompt_id: this.promptId,
        },
        signal,
        this.promptHookRunner,
      );
      const output =
        result &&
        createHookOutput(
          failed ? HookEventName.PostToolUseFailure : HookEventName.PostToolUse,
          result,
        );
      if (output?.shouldStopExecution())
        this.hookStopReason ??=
          output.getEffectiveReason() || 'Stopped by Hook.';
      const context = output?.getAdditionalContext();
      if (context) contextParts.push({ text: context });
    }
    const batch = await this.hooks.fire(
      HookEventName.PostToolBatch,
      `${this.promptId}:${calls.map((call) => call.callId).join(':')}`,
      {
        tool_calls: effective.map((call) => {
          const response = responses.find(
            (part) => part.functionResponse?.id === call.callId,
          )?.functionResponse?.response;
          return {
            tool_name: call.name,
            tool_input: call.args,
            tool_use_id: call.callId,
            status: physicalToolStatus(response),
            tool_response: response,
          };
        }),
        permission_mode: this.approval?.settings.mode ?? 'yolo',
        prompt_id: this.promptId,
      },
      signal,
      this.promptHookRunner,
    );
    const output =
      batch && createHookOutput(HookEventName.PostToolBatch, batch);
    if (output?.shouldStopExecution())
      this.hookStopReason ??= output.getEffectiveReason() || 'Stopped by Hook.';
    const context = output?.getAdditionalContext();
    if (context) contextParts.push({ text: context });
    if (contextParts.length) {
      if (!this.messageFitsInline('tool_result', contextParts, model)) {
        this.hookStopReason ??=
          'Hook context exceeds the inline Session Store limit.';
        return [...responses];
      }
      const batchId = `${this.promptId}:${calls.map((call) => call.callId).join(':')}`;
      const uuid = shellHistoryId(`${batchId}:hook-context`);
      if (!history.some((entry) => entry.uuid === uuid))
        await this.commit('tool_result', contextParts, model, {
          uuid,
          timestamp: assistant?.timestamp ?? new Date(0).toISOString(),
        });
    }
    return [...responses, ...contextParts];
  }

  async resumeHookResults(
    responses: readonly Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    if (!this.hooks) return [...responses];
    const history = await this.session.sink.project();
    const assistant = history.findLast(
      (entry) =>
        entry.type === 'assistant' &&
        entry.daemonPromptId === this.promptId &&
        entry.message?.parts?.some((part) => part.functionCall),
    );
    if (!assistant?.message?.parts)
      throw new HostedToolRecoveryRequiredError(
        'Original Hook batch is unavailable.',
      );
    const calls = assistant.message.parts.flatMap((part) =>
      part.functionCall
        ? [
            {
              name: part.functionCall.name!,
              callId: part.functionCall.id!,
              args: part.functionCall.args ?? {},
              isClientInitiated: false,
              prompt_id: this.promptId,
            },
          ]
        : [],
    );
    const contextId = shellHistoryId(
      `${this.promptId}:${calls.map((call) => call.callId).join(':')}:hook-context`,
    );
    const savedContext =
      history.find((entry) => entry.uuid === contextId)?.message?.parts ?? [];
    const original = savedContext.length
      ? responses.slice(0, -savedContext.length)
      : [...responses];
    return this.completeHookResults(
      calls,
      original,
      assistant.model ?? model,
      signal,
    );
  }

  setPromptHookRunner(runner: HostedPromptHookRunner): void {
    this.promptHookRunner = runner;
  }

  setModelRound(round: number): void {
    this.logicalRound = round;
  }

  async resumeSavedNativeBatch(
    saved: RestoredHostedApprovalContinuation,
    nextApprovalOrdinal: number,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const plan = saved.plan;
    this.unanswered = plan.calls.some(
      (item) =>
        item.actionId &&
        this.session.authority.action(item.actionId)?.state === 'expired',
    );
    if (
      this.hooks ||
      this.mcp ||
      this.promptId !== plan.promptId ||
      this.broker.runtimeSessionId !== plan.runtime.runtimeSessionId
    )
      throw new HostedToolRecoveryRequiredError(
        'Unsupported saved batch owner.',
      );
    this.uncertain = true;
    try {
      await waitForTurn(this.warmed, signal);
      this.broker.runtime = {
        bindingId: plan.runtime.bindingId,
        generation: plan.runtime.generation,
        workspaceGeneration: plan.runtime.workspaceGeneration,
      };
      await oweHostedTurnCleanup(this.session, this.promptId, this.broker);
      this.cleanupOwed = true;
      await this.broker.acquire({
        runtimeBindingId: plan.runtime.bindingId,
        generation: plan.runtime.generation,
      });
      this.acquired = true;
      if (
        !this.broker.runtime ||
        this.broker.runtime.workspaceGeneration !==
          plan.runtime.workspaceGeneration
      )
        throw new Error('Original Workspace generation changed.');
      if (this.context?.read() === undefined)
        await this.fetchWorkspaceContext(signal);
      const declarations = await this.declarations(signal);
      const requests: HostedPreparedRequest[] = [];
      for (const [ordinal, item] of plan.calls.entries()) {
        const definition = JSON.parse(
          (await this.session.resources.read(item.definitionRef)).toString(
            'utf8',
          ),
        ) as unknown;
        if (
          !isDeepStrictEqual(
            definition,
            declarations.find((tool) => tool.name === item.call.name),
          )
        )
          throw new Error('Original native tool definition changed.');
        const input = saved.inputs[ordinal];
        if (item.argsDigest !== `sha256:${managedToolDigest(input.input)}`)
          throw new Error('Original native arguments changed.');
        requests.push({
          call: item.call,
          input: input.input,
          runtimeCallId: item.runtimeCallId,
          payloadJson: input.payloadJson,
          inputBytes: input.bytes,
          digest: item.requestDigest,
          argsDigest: item.argsDigest,
          isShell: false,
          mcp: false,
          publicationId: null,
          background: false,
          monitoring: false,
          agent: false,
          workflow: false,
          agentBackground: true,
          team: false,
          message: false,
          command: false,
          skill: item.call.name === 'skill' && this.skills !== undefined,
        });
      }
      this.logicalRound = plan.round;
      return await this.executeNative(
        plan.calls.map((item) => item.call),
        saved.parts,
        plan.model,
        signal,
        { saved, requests, nextApprovalOrdinal },
      );
    } catch (cause) {
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  private async captureNativeBatch(
    stage: 'approval' | 'final',
    actionId: string | null,
    approvalOrdinal: number,
  ): Promise<ManagedSessionDurableRef | undefined> {
    const batch = this.nativeBatch;
    const runtime = this.broker.runtime;
    if (
      !batch ||
      batch.uncaptured ||
      !runtime ||
      isHostedWorkspaceShellProfile(this.profile) ||
      this.hooks ||
      this.mcp ||
      batch.requests.some(
        (request) =>
          !['read_file', 'write_file', 'edit', 'glob'].includes(
            request.call.name,
          ) ||
          // A call refused at the canonical-digest ceiling (#13803 D1) has
          // no argument digest a restore could re-verify, and one refused
          // past the inline limit has no encoding to publish.
          request.argsDigest === undefined ||
          request.inputBytes.length === 0,
      )
    )
      return undefined;
    const authority = this.session.authority;
    const header = authority.sessionHeader;
    const assistant = authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'message.committed' &&
          event.payload['messageId'] === batch.messageId,
      );
    if (!assistant) throw new Error('Original assistant batch is not durable.');
    const calls = [];
    for (const [ordinal, request] of batch.requests.entries()) {
      let inputRef = batch.inputRefs.get(ordinal);
      if (!inputRef) {
        inputRef = await this.session.resources.publish(
          'managed-tool-input',
          request.inputBytes,
        );
        batch.inputRefs.set(ordinal, inputRef);
      }
      let definitionRef = batch.definitionRefs.get(ordinal);
      if (!definitionRef) {
        definitionRef = await this.session.resources.publish(
          'managed-tool-definition',
          Buffer.from(
            JSON.stringify(
              this.advertised!.find((tool) => tool.name === request.call.name),
            ),
          ),
        );
        batch.definitionRefs.set(ordinal, definitionRef);
      }
      calls.push({
        call: request.call,
        runtimeCallId: request.runtimeCallId,
        inputRef,
        definitionRef,
        requestDigest: request.digest,
        // Present: a batch with an undigested call is never captured.
        argsDigest: request.argsDigest as string,
        prepareKey: `${this.broker.runtimeSessionId}:${request.runtimeCallId}`,
        prepareReference: {
          sessionId: this.broker.runtimeSessionId,
          promptId: this.promptId,
          callId: request.runtimeCallId,
          argsDigest: request.digest,
        },
        partIndex: batch.parts.findIndex(
          (part) => part.functionCall?.id === request.call.callId,
        ),
        refusal: batch.refusals[ordinal] ?? null,
        actionId: batch.actionIds.get(ordinal) ?? null,
      });
    }
    const plan: HostedApprovalContinuation = {
      v: 1,
      sessionKey: header.sessionKey,
      promptId: this.promptId,
      definitionRef: header.definitionRef,
      rootSnapshotRef: header.rootSnapshotRef,
      sourceActivation: this.session.activation,
      runtime: { runtimeSessionId: this.broker.runtimeSessionId, ...runtime },
      batchId: batch.messageId,
      assistantRef: assistant.payload[
        'contentRef'
      ] as unknown as ManagedSessionDurableRef,
      model: batch.model,
      round: this.logicalRound,
      stage,
      approvalOrdinal,
      actionId,
      calls,
    };
    const planBytes = Buffer.from(JSON.stringify(plan));
    if (
      planBytes.byteLength >
      HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
    )
      return undefined;
    const planRef = await this.session.resources.publish(
      'hosted-approval-continuation',
      planBytes,
    );
    if (stage === 'final') {
      const activation = this.session.activation;
      const planRevision =
        authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .filter(
            (event) =>
              event.kind === 'hosted.batch.planned' &&
              event.payload['batchId'] === batch.messageId,
          ).length + 1;
      await authority.appendExecutionEvent(
        {
          operation: 'hostedBatchPlan',
          commandId: `hosted-batch:${batch.messageId}:${planRevision}`,
          sessionKey: header.sessionKey,
          contentDigest: planRef.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `hosted-batch:${batch.messageId}:${planRevision}`,
          sessionKey: header.sessionKey,
          kind: 'hosted.batch.planned',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: activation.activationId,
            ...activation,
          },
          payload: { batchId: batch.messageId, planRevision, planRef },
        }),
        { class: 'harness', activation },
      );
    }
    return planRef;
  }

  private async executeNative(
    calls: ToolCallRequestInfo[],
    parts: Part[],
    model: string,
    signal: AbortSignal,
    restored?: {
      saved: RestoredHostedApprovalContinuation;
      requests: HostedPreparedRequest[];
      nextApprovalOrdinal: number;
    },
  ): Promise<Part[]> {
    signal.throwIfAborted();
    if (this.mcp) await waitForTurn(this.warmed, signal);
    const declarations = this.advertised ?? (await this.declarations(signal));
    this.hookPermission.clear();
    this.agentDispatched.clear();
    const mixedSkillBatch =
      this.skills !== undefined &&
      calls.some((call) => call.name === 'skill') &&
      calls.some((call) => call.name !== 'skill');
    if (this.hooks && this.approval && !mixedSkillBatch) {
      calls = await Promise.all(
        calls.map(async (call) => {
          const asks = hostedApprovalAsks(
            this.approval!.settings,
            call.name,
            this.searchProfile,
          );
          if (!asks || (call.name === 'skill' && this.skills)) return call;
          const output = await this.hooks!.fire(
            HookEventName.PermissionRequest,
            `${this.promptId}:${call.callId}`,
            {
              tool_name: call.name,
              tool_input: call.args,
              tool_use_id: call.callId,
              prompt_id: this.promptId,
            },
            signal,
            this.promptHookRunner,
          );
          const decision = output?.hookSpecificOutput?.['decision'] as
            | {
                behavior?: 'allow' | 'deny';
                updatedInput?: Record<string, unknown>;
              }
            | undefined;
          if (decision?.behavior)
            this.hookPermission.set(call.callId, decision.behavior);
          if (
            output?.continue === false ||
            output?.decision === 'block' ||
            output?.decision === 'deny'
          )
            this.hookPermission.set(call.callId, 'deny');
          return decision?.updatedInput
            ? { ...call, args: decision.updatedInput }
            : call;
        }),
      );
    }
    const prepareRequests = (
      source: ToolCallRequestInfo[],
    ): HostedPreparedRequest[] => {
      const ids = new Set<string>();
      return source.map((call) => {
        const runtimeCallId = randomUUID();
        const mcpInput = this.mcp?.toolInput(
          call.name,
          call.args,
          runtimeCallId,
        );
        const isShell = call.name === 'run_shell_command';
        const skill =
          mcpInput === undefined &&
          call.name === 'skill' &&
          this.skills !== undefined;
        if (
          !declarations.some((tool) => tool.name === call.name) ||
          ids.has(call.callId) ||
          // Refuse a call whose arguments arrived unterminated even when the
          // output token limit was not what cut them: this profile commits to a
          // remote Workspace with no undo backup, so a repaired partial
          // `content` or half-streamed command line is unrecoverable.
          call.wasOutputTruncated === true ||
          call.hadIncompleteArguments === true
        )
          throw new Error('Hosted Workspace profile refused a tool call.');
        ids.add(call.callId);
        let validationError: string | undefined;
        let input: Record<string, unknown>;
        let backgroundAdmitted = false;
        let monitorAdmitted = false;
        let agentAdmitted = false;
        let workflowAdmitted = false;
        let agentBackground = true;
        let messageAdmitted = false;
        // b3b: on a member Session the board vocabulary is its command
        // channel's, never the lead funnel's — the two never meet on one
        // profile, but a name collision must route to the command arm.
        // b3c decision 8: a member's send_message naming a member or
        // "*" is the same kind of command; only "parent" stays H4d-b's.
        const memberMessageCommand =
          mcpInput === undefined &&
          call.name === 'send_message' &&
          this.sendMessageRole() === 'child' &&
          this.memberPreamble === true &&
          typeof call.args['to'] === 'string' &&
          sanitizeName(call.args['to']) !== 'parent';
        const command =
          mcpInput === undefined &&
          (this.commandToolNames.has(call.name) || memberMessageCommand);
        const team =
          !command &&
          mcpInput === undefined &&
          (HOSTED_TEAM_TOOL_NAMES.includes(call.name) ||
            (call.name === 'team_plan_approval' &&
              teamPlanAdmissionsEnabled()));
        // H4e-b3 decision 9: a run whose first input carried an unescaped
        // plan-mode preamble admits reads only; every other call is
        // refused before it runs, ahead of any per-tool arm below.
        if (
          this.memberPlanMode &&
          !HOSTED_PLAN_MODE_READS.has(call.name) &&
          !(
            call.name === 'exit_plan_mode' &&
            command &&
            teamPlanAdmissionsEnabled()
          )
        ) {
          validationError = hostedPlanModeRefusal();
          input = { ...call.args };
        } else if (mcpInput) {
          input = { ...mcpInput.input };
        } else if (skill) {
          validationError = source.some((other) => other.name !== 'skill')
            ? HOSTED_SKILL_BATCH_REFUSAL
            : this.skills!.validationError(call.args);
          input = { ...call.args };
        } else if (isShell) {
          const args = call.args;
          const unsupportedKey = Object.keys(args).find(
            (key) =>
              !['command', 'timeout', 'description', 'is_background'].includes(
                key,
              ),
          );
          // H3: a background request is admitted exactly when this Session
          // owns its child_run orchestrator and the domain is enabled — the
          // deliberate refusals below keep their texts otherwise.
          const backgroundRequested =
            args['is_background'] === true ||
            (typeof args['is_background'] === 'string' &&
              args['is_background'].toLowerCase() === 'true');
          const backgroundIllFormed =
            !backgroundRequested &&
            args['is_background'] !== undefined &&
            args['is_background'] !== false &&
            !(
              typeof args['is_background'] === 'string' &&
              args['is_background'].toLowerCase() === 'false'
            );
          backgroundAdmitted =
            backgroundRequested &&
            // The admitted family runs v3 only: a shell-mode turn has no
            // publication to drive it, so admitting there would only re-
            // send the request into the background-refusing v2 path.
            this.publication !== undefined &&
            this.childRuns !== undefined &&
            childRunAdmissionsEnabled();
          if (typeof args['command'] !== 'string' || !args['command'].trim()) {
            validationError = 'Hosted Shell requires a nonempty command.';
          } else if (unsupportedKey !== undefined) {
            validationError = `Hosted Shell received unsupported argument ${JSON.stringify(unsupportedKey)}.`;
          } else if (
            backgroundIllFormed ||
            (backgroundRequested && !backgroundAdmitted)
          ) {
            validationError =
              'Hosted Shell requires a foreground command in the saved directory. Background jobs and Monitor are unavailable; correct the arguments before retrying.';
          } else if (
            args['description'] !== undefined &&
            typeof args['description'] !== 'string'
          ) {
            validationError = 'Hosted Shell description must be a string.';
          } else if (
            args['timeout'] !== undefined &&
            (!Number.isSafeInteger(args['timeout']) ||
              (args['timeout'] as number) < 1 ||
              (args['timeout'] as number) > 600000)
          ) {
            validationError =
              'Hosted Shell timeout must be an integer from 1 to 600000 ms.';
          }
          if (
            !backgroundAdmitted &&
            this.publication &&
            args['is_background'] !== undefined
          ) {
            validationError = 'Hosted Shell requires one foreground command.';
          }
          input = backgroundAdmitted
            ? { ...args, is_background: true }
            : this.publication
              ? { ...args }
              : { ...args, is_background: false };
        } else if (call.name === 'glob') {
          input = { ...call.args };
          const globError =
            'Hosted glob requires a nonempty pattern, and its optional path must be relative to the saved Session working directory. Absolute paths and ".." traversal are not allowed. Correct the arguments and retry.';
          const requestedPattern = call.args['pattern'];
          const directory = call.args['path'];
          // A pattern is a second search root: refuse the absolute/`..` and
          // oversized shapes here, pre-acquisition, with the identical check
          // the worker applies after dispatch — a refusal before acquisition
          // stays model-correctable and costs no durable Runtime work
          // (#13030). Validate the value that gets dispatched, never the raw
          // one: glob treats an untrimmed pattern as a literal, so it matches
          // nothing and the false negative is persisted.
          const pattern =
            typeof requestedPattern === 'string' ? requestedPattern.trim() : '';
          const check = pattern ? checkHostedGlobPattern(pattern) : 'escapes';
          if (check === 'too-complex') {
            validationError = HOSTED_GLOB_TOO_COMPLEX;
          } else if (check === 'escapes') {
            validationError = globError;
          } else {
            input['pattern'] = pattern;
          }
          if (!validationError && directory !== undefined) {
            if (
              directory === null ||
              (typeof directory === 'string' && directory.trim() === '')
            ) {
              // A blank or `null` path is the omitted case: the declaration
              // marks it optional, and the executor maps a missing key to the
              // Session root — refusing it as traversal would also poison every
              // valid sibling call in the batch.
              delete input['path'];
            } else if (typeof directory !== 'string') {
              validationError = globError;
            } else {
              try {
                input['path'] = normalizeWorkspaceRelativePath(
                  directory.trim(),
                );
              } catch (cause) {
                if (!(cause instanceof InvalidWorkspaceRelativePathError))
                  throw cause;
                validationError = globError;
              }
            }
          }
        } else if (call.name === 'monitor') {
          const args = call.args;
          const unsupportedKey = Object.keys(args).find(
            (key) =>
              ![
                'command',
                'idle_timeout_ms',
                'max_events',
                'description',
              ].includes(key),
          );
          // H3: a Monitor request is admitted exactly when this Session
          // owns its monitor_run orchestrator and the detached family has
          // its v3 flow — publication — without it the request refuses at
          // admission rather than travelling v2 and never landing.
          monitorAdmitted =
            this.monitors !== undefined &&
            this.publication !== undefined &&
            monitorRunAdmissionsEnabled();
          if (typeof args['command'] !== 'string' || !args['command'].trim()) {
            validationError = 'Hosted Monitor requires a nonempty command.';
          } else if (unsupportedKey !== undefined) {
            validationError = `Hosted Monitor received unsupported argument ${JSON.stringify(unsupportedKey)}.`;
          } else if (!monitorAdmitted) {
            validationError =
              'Hosted Monitor is unavailable on this Session profile; read output through the task surface instead.';
          } else if (
            args['description'] !== undefined &&
            typeof args['description'] !== 'string'
          ) {
            validationError = 'Hosted Monitor description must be a string.';
          } else if (
            args['idle_timeout_ms'] !== undefined &&
            (!Number.isSafeInteger(args['idle_timeout_ms']) ||
              (args['idle_timeout_ms'] as number) < 1 ||
              (args['idle_timeout_ms'] as number) > 600000)
          ) {
            validationError =
              'Hosted Monitor idle_timeout_ms must be an integer from 1 to 600000 ms.';
          } else if (
            args['max_events'] !== undefined &&
            (!Number.isSafeInteger(args['max_events']) ||
              (args['max_events'] as number) < 1 ||
              (args['max_events'] as number) > 10000)
          ) {
            validationError =
              'Hosted Monitor max_events must be an integer from 1 to 10000.';
          }
          input = { ...args, is_monitor: true };
        } else if (call.name === 'agent') {
          const args = call.args;
          // The deliberate refusals below keep their texts whenever the
          // Agent call is not admitted.
          agentAdmitted = this.agentsAdmitted();
          const teamsOn = this.teamsAdmitted();
          const named = teamsOn && args['name'] !== undefined;
          const unsupportedKey = Object.keys(args).find(
            (key) =>
              ![
                'description',
                'prompt',
                'run_in_background',
                ...(named ? ['name'] : []),
                ...(named && teamPlanAdmissionsEnabled()
                  ? ['plan_mode_required']
                  : []),
                'isolation',
              ].includes(key),
          );
          const backgroundValue = args['run_in_background'];
          agentBackground = !(
            backgroundValue === false ||
            (typeof backgroundValue === 'string' &&
              backgroundValue.toLowerCase() === 'false')
          );
          const backgroundIllFormed =
            backgroundValue !== undefined &&
            backgroundValue !== true &&
            backgroundValue !== false &&
            !(
              typeof backgroundValue === 'string' &&
              ['true', 'false'].includes(backgroundValue.toLowerCase())
            );
          if (!agentAdmitted) {
            validationError =
              'Hosted child agents are unavailable on this Session profile; read work through ordinary tools instead.';
          } else if (unsupportedKey !== undefined) {
            validationError = `Hosted child agent received unsupported argument ${JSON.stringify(unsupportedKey)}. This profile runs only the Session's own definition, without nesting: fork_*, working_dir, ${teamsOn ? '' : 'name, '}model and subagent_type belong to the legacy Agent tool.`;
          } else if (
            args['isolation'] !== undefined &&
            args['isolation'] !== 'worktree'
          ) {
            validationError =
              'Hosted child agent isolation must be "worktree" or omitted.';
          } else if (
            args['plan_mode_required'] !== undefined &&
            typeof args['plan_mode_required'] !== 'boolean'
          ) {
            validationError =
              'Hosted child agent plan_mode_required must be a boolean.';
          } else if (backgroundIllFormed) {
            validationError =
              'Hosted child agent run_in_background must be a boolean.';
          } else if (named && !agentBackground) {
            validationError =
              'Hosted team member always runs in the background; omit run_in_background or set it to true.';
          } else if (this.sessionOwnerMayHoldMount()) {
            validationError = `Hosted child agent is unavailable while ${HOSTED_CHILD_MOUNT_REFUSALS.sessionOwner}; a Session-owned hold releases only when the Session closes, so read the work through ordinary tools instead.`;
          } else if (!agentBackground && this.acquired) {
            // A foreground child cannot borrow its waiting parent's mount.
            // Ordered after the Session-owner arm: a Session-scoped mount
            // outlives this Turn, so the background and fresh-turn advice
            // here would not release it. Swapping the two arms hands a
            // Session-owned hold advice that cannot act on it.
            validationError = `Hosted child agent run_in_background=false is unavailable while ${HOSTED_CHILD_MOUNT_REFUSALS.turn}; run it in the background or let the current tool work finish first in a fresh turn.`;
          } else if (
            !agentBackground &&
            calls.some(
              (other) => other.name !== 'agent' && other.name !== 'workflow',
            )
          ) {
            // The same one-batch candidacy: a sibling outside a child
            // launch holds the mount for exactly the wait the foreground
            // answer needs.
            validationError =
              'Hosted child agent run_in_background=false cannot share a batch with a tool other than agent or workflow; the sibling would hold the Workspace mount the child needs.';
          } else if (
            typeof args['description'] !== 'string' ||
            !args['description'].trim() ||
            Buffer.byteLength(args['description'], 'utf8') >
              MANAGED_CHILD_LIMITS.maxDescriptionBytes
          ) {
            validationError = `Hosted child agent requires a nonempty description of at most ${MANAGED_CHILD_LIMITS.maxDescriptionBytes} bytes.`;
          } else if (
            typeof args['prompt'] !== 'string' ||
            !args['prompt'].trim()
          ) {
            validationError = 'Hosted child agent requires a nonempty prompt.';
          } else if (named) {
            validationError = this.memberBatchError(call, source);
          }
          input = { ...args };
        } else if (call.name === 'workflow') {
          const args = call.args;
          // #13803: the Workflow call answers the same admission shape as
          // the Agent call, behind its own kind reader.
          workflowAdmitted =
            this.childAgents !== undefined &&
            (this.shell !== undefined || this.backgroundLane !== undefined) &&
            this.childDepth === 0 &&
            childWorkflowAdmissionsEnabled();
          const unsupportedKey = Object.keys(args).find(
            (key) => !['script', 'args', 'run_in_background'].includes(key),
          );
          const backgroundValue = args['run_in_background'];
          agentBackground = !(
            backgroundValue === false ||
            (typeof backgroundValue === 'string' &&
              backgroundValue.toLowerCase() === 'false')
          );
          const backgroundIllFormed =
            backgroundValue !== undefined &&
            backgroundValue !== true &&
            backgroundValue !== false &&
            !(
              typeof backgroundValue === 'string' &&
              ['true', 'false'].includes(backgroundValue.toLowerCase())
            );
          if (!workflowAdmitted) {
            validationError =
              'Hosted workflow children are unavailable on this Session profile; read work through ordinary tools instead.';
          } else if (unsupportedKey !== undefined) {
            validationError = `Hosted workflow received unsupported argument ${JSON.stringify(unsupportedKey)}. This profile runs a complete inline script only: name, scriptPath, resumeFromRunId and sourceRef belong to the legacy Workflow tool and its reference follow-up.`;
          } else if (backgroundIllFormed) {
            validationError =
              'Hosted workflow run_in_background must be a boolean.';
          } else if (this.sessionOwnerMayHoldMount()) {
            validationError = `Hosted workflow is unavailable while ${HOSTED_CHILD_MOUNT_REFUSALS.sessionOwner}; a Session-owned hold releases only when the Session closes, so read the work through ordinary tools instead.`;
          } else if (!agentBackground && this.acquired) {
            validationError = `Hosted workflow run_in_background=false is unavailable while ${HOSTED_CHILD_MOUNT_REFUSALS.turn}; run it in the background or let the current tool work finish first in a fresh turn.`;
          } else if (
            !agentBackground &&
            calls.some(
              (other) => other.name !== 'agent' && other.name !== 'workflow',
            )
          ) {
            validationError =
              'Hosted workflow run_in_background=false cannot share a batch with a tool other than agent or workflow; the sibling would hold the Workspace mount the child needs.';
          } else if (
            typeof args['script'] !== 'string' ||
            !args['script'].trim()
          ) {
            validationError = 'Hosted workflow requires a nonempty script.';
          } else if (
            Buffer.byteLength(args['script'], 'utf8') >
            MANAGED_CHILD_LIMITS.maxEnvelopeBytes
          ) {
            // The byte bound consulted before any V8 work: the compile
            // and the shape scan below would throw their results away.
            validationError = `Hosted workflow script exceeds ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes} bytes (byte_limit).`;
          } else {
            // An unstartable script is a model-correctable argument
            // error, so it refuses here with the runner's own texts
            // rather than wedging the child's first Turn on its compile:
            // a failed child Session is the answer for a run that fails,
            // never for one that could never start. The args value walks
            // first: nesting the launch cannot commit refuses here — the
            // model fixes the value and retries at no quota or slot spent.
            const argsRefusal = workflowArgsRefusal(args['args']);
            if (argsRefusal !== undefined) {
              validationError = argsRefusal;
            }
            if (validationError === undefined) {
              const gate = workflowPreLaunchGate(args['script']);
              if (gate.refusal !== undefined) {
                validationError = `Hosted workflow script is invalid: ${gate.refusal.detail}`;
              } else if (gate.shape.nestedWorkflowCalls.length > 0) {
                // A nested launch resolves script bytes the pin never
                // examined (a saved workflow from any tier). Refuse with
                // the same model-correctable text the reference arguments
                // carry, so the launched bytes stay exactly the pinned
                // ones.
                const extra = gate.shape.nestedWorkflowCalls.length - 1;
                validationError = `Hosted workflow script is invalid: workflow() on line ${gate.shape.nestedWorkflowCalls[0]}${extra > 0 ? ` and ${extra} more` : ''} launches a nested run whose script this launch never pinned. This profile runs a complete inline script only: name, scriptPath, resumeFromRunId and sourceRef belong to the legacy Workflow tool and its reference follow-up.`;
              } else if (gate.shape.hostBoundAgentOptions.length > 0) {
                // The child refuses these at dispatch and fails the whole
                // run; refusing here keeps the model's correction free of
                // a spent launch slot (#13858 R4-4).
                const [first] = gate.shape.hostBoundAgentOptions;
                validationError = `Hosted workflow script is invalid: agent() on line ${first.line} passes ${first.option}. ${HOSTED_WORKFLOW_TEXT_ONLY_AGENTS}`;
              }
            }
          }
          input = { ...args };
        } else if (call.name === 'send_message') {
          const args = call.args;
          const role = this.sendMessageRole();
          // b3c: a member message is a command to the leader, never
          // H4d-b's plain message.
          messageAdmitted = role !== undefined && !memberMessageCommand;
          // H4e-b2: beside the team tools, the lead also addresses a member
          // by name, or every member with "*".
          const teamForm = role === 'parent' && this.teamsAdmitted();
          const keys =
            role === 'child'
              ? ['to', 'message']
              : teamForm
                ? ['to', 'task_id', 'message']
                : ['task_id', 'message'];
          const unsupportedKey = Object.keys(args).find(
            (key) => !keys.includes(key),
          );
          const text = args['message'];
          if (role === undefined) {
            validationError =
              'Hosted session messages are unavailable on this Session profile.';
          } else if (unsupportedKey !== undefined) {
            validationError =
              role === 'child'
                ? this.memberPreamble === true
                  ? `Hosted send_message received unsupported argument ${JSON.stringify(unsupportedKey)}. A member send_message takes only a member's to: "parent", a member name, or "*" — pass to and message.`
                  : `Hosted send_message received unsupported argument ${JSON.stringify(unsupportedKey)}. A child Session messages only its parent: pass to "parent" and message.`
                : teamForm
                  ? `Hosted send_message received unsupported argument ${JSON.stringify(unsupportedKey)}. Pass to (a member name, or "*" for every member) or task_id, and message; other Sessions belong to the legacy tool.`
                  : `Hosted send_message received unsupported argument ${JSON.stringify(unsupportedKey)}. This Session messages only the child agents it launched: pass task_id and message; teams and other Sessions belong to the legacy tool.`;
          } else if (
            role === 'child' &&
            this.memberPreamble !== true &&
            args['to'] !== 'parent'
          ) {
            validationError =
              'Hosted send_message from a child Session addresses only to "parent".';
          } else if (role === 'child' && this.memberPreamble === true) {
            // b3c decision 8: a member names "parent", another member, or
            // "*". Member-addressed sends are commands to the leader; the
            // local refusals answer before anything is sent.
            const addressed =
              typeof args['to'] === 'string' ? args['to'].trim() : '';
            if (addressed === '') {
              validationError =
                'Hosted send_message requires "to": "parent" for the team leader, a member name, or "*" for every other member.';
            } else if (memberMessageCommand && this.memberPlanMode) {
              validationError = hostedPlanModeRefusal();
            } else if (
              memberMessageCommand &&
              this.memberIdentity?.name !== undefined &&
              sanitizeName(addressed) === this.memberIdentity.name
            ) {
              validationError = `A member cannot send a message to itself ("${this.memberIdentity.name}").`;
            } else if (
              memberMessageCommand &&
              sanitizeName(addressed) === MANAGED_TEAM_LEADER
            ) {
              validationError =
                'A member messages its leader with send_message with to "parent", not "leader".';
            } else if (typeof text !== 'string' || !text.trim()) {
              validationError =
                'Hosted send_message requires a nonempty message.';
            } else if (
              memberMessageCommand &&
              Buffer.byteLength(
                memberMessageContent(
                  this.memberIdentity?.name ?? '',
                  text as string,
                ),
                'utf8',
              ) > MANAGED_CHILD_LIMITS.maxEnvelopeBytes
            ) {
              validationError = `Hosted send_message message is too long for a member message (byte_limit): with its wrapper it must fit ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes} bytes.`;
            } else if (
              memberMessageCommand &&
              source.some(
                (other) =>
                  other !== call &&
                  !this.commandToolNames.has(other.name) &&
                  other.name !== 'send_message',
              )
            ) {
              validationError =
                'Hosted send_message to a member cannot share a batch with Workspace or Runtime calls; a command parks the Turn while the leader answers, so run it in its own batch or beside the member board commands.';
            }
          } else if (
            teamForm &&
            (args['to'] === undefined) === (args['task_id'] === undefined)
          ) {
            validationError =
              'Hosted send_message takes exactly one of to (a member name, or "*" for every member) and task_id.';
          } else if (
            teamForm &&
            args['to'] !== undefined &&
            (typeof args['to'] !== 'string' || !args['to'].trim())
          ) {
            validationError =
              'Hosted send_message "to" must be a member name, or "*" for every member.';
          } else if (
            teamForm &&
            isBroadcast(args['to']) &&
            source.some(
              (other) =>
                other !== call &&
                (other.name === 'team_create' ||
                  other.name === 'team_delete' ||
                  (other.name === 'agent' && other.args['name'] !== undefined)),
            )
          ) {
            // A re-driven batch then reads the roster the broadcast read.
            validationError =
              'Hosted send_message to "*" cannot share a batch with team_create, team_delete or a member launch; let the roster change land first.';
          } else if (
            role === 'parent' &&
            args['to'] === undefined &&
            (typeof args['task_id'] !== 'string' || !args['task_id'].trim())
          ) {
            validationError =
              'Hosted send_message requires the task_id a child agent launch returned.';
          } else if (typeof text !== 'string' || !text.trim()) {
            validationError =
              'Hosted send_message requires a nonempty message.';
          } else if (
            Buffer.byteLength(text, 'utf8') >
            MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes
          ) {
            validationError = `Hosted send_message message exceeds ${MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes} bytes.`;
          }
          input =
            teamForm || memberMessageCommand
              ? hostedTeamMessageInput(args)
              : { ...args };
        } else if (command) {
          validationError = this.commandArgumentError(call, source);
          input = { ...call.args };
        } else if (team) {
          validationError = hostedTeamArgumentError(call.name, call.args);
          input = { ...call.args };
        } else {
          const file = call.args['file_path'];
          input = { ...call.args };
          const filePathError =
            'Hosted file tools require file_path relative to the saved Session working directory. Absolute paths and ".." traversal are not allowed. Correct file_path and retry.';
          if (typeof file !== 'string') {
            validationError = filePathError;
          } else {
            try {
              input['file_path'] = normalizeWorkspaceRelativePath(file.trim());
            } catch (cause) {
              if (!(cause instanceof InvalidWorkspaceRelativePathError))
                throw cause;
              validationError = filePathError;
            }
          }
        }
        // The inline Session Store limit keeps rejecting exactly as main
        // does for the ordinary tools. A call that already carries its own
        // refusal never reads its encoding, and a workflow launch is this
        // profile's own surface: for either the limit becomes the call's
        // refusal, never a failure of the whole Turn (review D1/R2-12).
        let encoded: HostedEncodedToolInput;
        try {
          encoded = this.encodeToolInput(
            mcpInput ?? { toolName: call.name, input },
          );
        } catch (cause) {
          if (
            !(cause instanceof HostedToolInputInlineLimitError) ||
            (validationError === undefined && call.name !== 'workflow')
          )
            throw cause;
          validationError ??= `Hosted workflow script and args exceed the ${HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes}-byte inline Session Store limit once encoded (byte_limit); shorten them and retry.`;
          encoded = UNENCODED_TOOL_INPUT;
        }
        // H3: the publication evidence chain pins the canonical input
        // digest for Monitor calls exactly like Shell calls.
        let argsDigest: string | undefined;
        let inputDigest: string | undefined;
        try {
          inputDigest =
            isShell || call.name === 'monitor'
              ? managedToolDigest(input)
              : undefined;
          argsDigest = `sha256:${managedToolDigest(input)}`;
        } catch (cause) {
          if (!(cause instanceof ManagedToolProtocolError)) throw cause;
          // An arm's own, more specific refusal of the same input stands.
          validationError ??= `Hosted tool input cannot commit as protocol evidence: ${cause.message}`;
        }
        return {
          call,
          validationError,
          input,
          isShell,
          inputDigest,
          mcp: mcpInput !== undefined,
          ...encoded,
          argsDigest,
          publicationId:
            (isShell || (call.name === 'monitor' && monitorAdmitted)) &&
            this.publication
              ? randomUUID()
              : null,
          runtimeCallId,
          background: mcpInput === undefined && backgroundAdmitted,
          monitoring: mcpInput === undefined && monitorAdmitted,
          agent: mcpInput === undefined && agentAdmitted,
          workflow: mcpInput === undefined && workflowAdmitted,
          agentBackground,
          message:
            mcpInput === undefined && messageAdmitted && !memberMessageCommand,
          team,
          command,
          skill,
        };
      });
    };
    let requests = restored?.requests ?? prepareRequests(calls);
    if (!this.messageFitsInline('assistant', parts, model))
      throw new Error(
        'Hosted assistant record exceeds the inline Session Store limit.',
      );
    if (
      calls.some(
        (call) =>
          !this.messageFitsInline(
            'tool_result',
            convertToFunctionErrorResponse(
              call.name,
              call.callId,
              [],
              'The turn was cancelled before this tool call ran.',
            ),
            model,
          ),
      )
    )
      throw new Error(
        'Hosted tool cancellation exceeds the inline Session Store limit.',
      );
    signal.throwIfAborted();
    if (requests.some((request) => request.validationError)) {
      const responses = requests.flatMap((request) =>
        convertToFunctionErrorResponse(
          request.call.name,
          request.call.callId,
          [],
          request.validationError ??
            'This tool was not executed because another call in the batch has invalid arguments. Retry the batch with corrected arguments.',
        ),
      );
      if (!this.messageFitsInline('tool_result', responses, model))
        throw new Error(
          'Hosted tool refusal exceeds the inline Session Store limit.',
        );
      this.uncertain = true;
      try {
        await this.commit('assistant', parts, model);
        await this.commit('tool_result', responses, model);
        this.uncertain = false;
        return responses;
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      }
    }
    if (this.hooks || this.mcp || requests.some((request) => !request.skill))
      await waitForTurn(this.warmed, signal);
    // H4b: an agent-only batch runs entirely inside its own Sessions and
    // needs no Runtime at all — holding the parent's mount across the
    // child's wait is exactly the deadlock a shared Workspace creates
    // (parent turn held, child tool call queued behind it forever). v1
    // therefore takes the mount only for a batch with at least one
    // non-agent tool; a workflow launch is a child launch of the same
    // shape (#13803). A session message (H4d-b) commits a record and
    // touches no Runtime either, and H4e-b1's team tools touch only
    // the journal.
    if (
      !this.acquired &&
      requests.some(
        (request) =>
          request.agent !== true &&
          request.workflow !== true &&
          request.message !== true &&
          !request.team &&
          request.command !== true &&
          !request.skill,
      )
    ) {
      // Acquisition may have taken effect even when its reply is lost.
      await this.acquire(false, signal);
    }
    if (signal.aborted) {
      this.uncertain = false;
      signal.throwIfAborted();
    }
    const shellBindings = new Map<
      string,
      {
        publicationId: string;
        publicationToken: string;
        runtimeBindingId: string;
        bindingGeneration: string;
        runtimeCallId: string;
        argsDigest: string;
        requestDigest: string;
        argsRef: ManagedSessionDurableRef;
        intentSequence: number;
        modelCallId: string;
        captureId: string;
        originalBinding?: ToolPublicationBinding;
      }
    >();
    let renewTimer: NodeJS.Timeout | undefined;
    let renewInFlight: Promise<void> | null = null;
    let renewGrants: (() => Promise<void>) | undefined;
    let messageId: string;
    let refusals: Array<string | undefined>;
    const inputRefs = new Map<number, ManagedSessionDurableRef>(
      restored?.saved.plan.calls.map((item, ordinal) => [
        ordinal,
        item.inputRef,
      ]),
    );
    const definitionRefs = new Map<number, ManagedSessionDurableRef>(
      restored?.saved.plan.calls.map((item, ordinal) => [
        ordinal,
        item.definitionRef,
      ]),
    );
    try {
      this.uncertain = true;
      if (
        this.shell &&
        requests.some((request) => request.isShell || request.monitoring) &&
        !this.publisher
      ) {
        this.publisher = this.shell!.publisher ??= new HostedShellPublisher(
          this.session,
          this.shell!.resources,
          this.shell!.assertWritable,
          this.childRuns,
          this.monitors,
          () => this.shell!.monitorWakeKick?.(),
        );
        this.bindingGeneration = await this.broker.registerPublisher(
          await this.publisher.start(),
        );
      } else if (
        this.publication &&
        this.backgroundLane &&
        requests.some((request) => request.background || request.monitoring) &&
        !this.publisher
      ) {
        // Publication mode: the record funnel of the detached family is
        // this Session's, exactly like without capture bytes — without it
        // a background exit's settle and tail could never reach the record.
        this.publisher = this.backgroundLane.publisher ??=
          new HostedShellPublisher(
            this.session,
            this.backgroundLane.resources,
            this.backgroundLane.assertWritable,
            this.childRuns,
            this.monitors,
            () => this.backgroundLane!.monitorWakeKick?.(),
          );
        this.bindingGeneration = await this.broker.registerPublisher(
          await this.publisher.start(),
        );
      }
      messageId =
        restored?.saved.plan.batchId ??
        (await this.commit('assistant', parts, model));
      this.nativeBatch = {
        messageId,
        model,
        parts,
        requests,
        refusals:
          restored?.saved.plan.calls.map((item) => item.refusal ?? undefined) ??
          requests.map((request) =>
            this.hookPermission.get(request.call.callId) === 'deny'
              ? 'PermissionRequest Hook denied the call.'
              : undefined,
          ),
        inputRefs,
        definitionRefs,
        actionIds: new Map(
          restored?.saved.plan.calls.flatMap((item, index) =>
            item.actionId ? [[index, item.actionId] as const] : [],
          ),
        ),
      };
      refusals =
        restored?.saved.plan.stage === 'final'
          ? this.nativeBatch.refusals
          : await this.approve(
              requests,
              messageId,
              inputRefs,
              signal,
              restored?.nextApprovalOrdinal ?? 0,
            );
      if (this.hooks) {
        const updated = requests.map((request) => request.call);
        const askAgain = new Set<number>();
        for (const [index, request] of requests.entries()) {
          if (refusals[index]) continue;
          const output = await this.hooks.fire(
            HookEventName.PreToolUse,
            `${this.promptId}:${request.call.callId}`,
            {
              tool_name: request.call.name,
              tool_input: request.call.args,
              tool_use_id: request.call.callId,
              permission_mode: this.approval?.settings.mode ?? 'yolo',
              prompt_id: this.promptId,
            },
            signal,
            this.promptHookRunner,
          );
          const parsed = output && new PreToolUseHookOutput(output);
          const permission = parsed?.getPermissionDecision();
          if (
            parsed?.shouldStopExecution() ||
            parsed?.isBlockingDecision() ||
            permission === 'deny'
          ) {
            refusals[index] =
              (permission === 'deny' &&
                parsed?.getPermissionDecisionReason()) ||
              parsed?.getEffectiveReason() ||
              'PreToolUse Hook denied the call.';
            continue;
          }
          if (request.skill && permission === 'ask') {
            refusals[index] = HOSTED_SKILL_APPROVAL_REFUSAL;
            continue;
          }
          const input = output?.hookSpecificOutput?.['updatedInput'];
          if (
            input &&
            typeof input === 'object' &&
            !Array.isArray(input) &&
            !isDeepStrictEqual(input, request.call.args)
          ) {
            updated[index] = {
              ...request.call,
              args: input as Record<string, unknown>,
            };
            inputRefs.delete(index);
            if (
              this.approval &&
              !request.skill &&
              hostedApprovalAsks(
                this.approval.settings,
                request.call.name,
                this.searchProfile,
              )
            )
              askAgain.add(index);
          }
          if (permission === 'ask') askAgain.add(index);
        }
        const revised = prepareRequests(updated);
        requests = requests.map((request, index) => {
          if (updated[index] !== request.call) return revised[index];
          // An unchanged call keeps its prepared request, but not its
          // stale verdict: the PreToolUse fire may have acquired the
          // Workspace mount (the Session's Hook owner retains it until
          // close), and prepareRequests re-evaluated the call against
          // that current Session. A refusal found only now must still
          // block the admission; a verdict never found is never invented.
          if (revised[index].validationError === undefined) return request;
          return {
            ...request,
            validationError: revised[index].validationError,
          };
        });
        for (const [index, request] of requests.entries()) {
          if (refusals[index]) continue;
          if (request.validationError) {
            refusals[index] = request.validationError;
            continue;
          }
          if (askAgain.has(index)) {
            if (!this.approval) {
              refusals[index] =
                'Hook requires approval, but no approval policy is available.';
              continue;
            }
            const inputRef = await this.session.resources.publish(
              'managed-tool-input',
              request.inputBytes,
            );
            inputRefs.set(index, inputRef);
            refusals[index] = await this.ask(
              this.approval,
              request.call,
              inputRef,
              messageId,
              signal,
            );
          }
        }
      }
      this.nativeBatch.requests = requests;
      this.nativeBatch.refusals = refusals;
      if (restored?.saved.plan.stage !== 'final')
        await this.captureNativeBatch(
          'final',
          null,
          Math.max(0, requests.length - 1),
        );
    } catch (cause) {
      throw new HostedToolRecoveryRequiredError(cause);
    }
    const refusal = (index: number): Part[] | undefined => {
      const reason = refusals[index];
      return reason === undefined
        ? undefined
        : convertToFunctionErrorResponse(
            requests[index].call.name,
            requests[index].call.callId,
            [],
            reason,
          );
    };
    const paths = requests.flatMap((request, index) =>
      !this.mcp &&
      refusals[index] === undefined &&
      ['write_file', 'edit'].includes(request.call.name)
        ? [request.input['file_path'] as string]
        : [],
    );
    if (paths.length) {
      try {
        const state = await this.broker.fileHistory({
          kind: 'raw-file-history',
          action: 'prepare',
          promptId: this.promptId,
          paths: [...new Set(paths)],
        });
        const prepared = {
          schemaVersion: 1 as const,
          state,
          pendingTurn: this.promptId,
          pendingMessageId: messageId,
          pendingUndo: null,
        };
        await assertHostedFileHistoryCapacity(this.session, prepared);
        await commitHostedFileHistory(this.session, prepared);
      } catch (cause) {
        if (
          !isHostedFileHistoryRefusal(cause) &&
          !(cause instanceof HostedFileHistoryRefusedError)
        )
          throw new HostedToolRecoveryRequiredError(cause);
        const reason =
          cause instanceof HostedWorkspaceBrokerRejection
            ? (cause.reason ?? cause.message)
            : cause.message;
        for (const [index, request] of requests.entries())
          if (
            refusals[index] === undefined &&
            ['write_file', 'edit'].includes(request.call.name)
          )
            refusals[index] =
              `Hosted file history refused this batch's Write/Edit before execution: ${reason.slice(0, 512)}`;
        paths.length = 0;
      }
    }
    // A Write/Edit about to change an instruction file makes the cached
    // context stale whatever its outcome; the next turn reads it again. A
    // refused batch emptied `paths` above and changes nothing.
    if (touchesWorkspaceContext(paths)) this.context?.invalidate();
    if (refusals.every((reason) => reason !== undefined)) {
      const responses = requests.flatMap((_, index) => refusal(index)!);
      try {
        if (!this.messageFitsInline('tool_result', responses, model))
          throw new Error(
            'Hosted tool refusal exceeds the inline Session Store limit.',
          );
        await this.commit('tool_result', responses, model);
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      }
      this.uncertain = false;
      signal.throwIfAborted();
      return responses;
    }
    const reserved = new Map<number, string>();
    try {
      const bindings = [];
      for (const [ordinal, request] of requests.entries()) {
        if (refusals[ordinal] !== undefined) continue;
        // A child launch has no Runtime execution to reserve: the control
        // plane's relay owns its side effect, so it never enters the
        // Broker pipeline below. Nor does a session message, a team tool,
        // or a session command, which commit only to this Session's
        // journal.
        if (
          request.agent ||
          request.message ||
          request.team ||
          request.command ||
          request.skill ||
          request.workflow
        )
          continue;
        if (request.mcp) {
          const renewed = this.mcp!.toolInput(
            request.call.name,
            request.call.args,
            request.runtimeCallId,
          )!;
          const payload = JSON.parse(request.payloadJson) as typeof renewed;
          Object.assign(
            request,
            this.encodeToolInput({
              ...payload,
              input: { ...payload.input, grant: renewed.input.grant },
            }),
          );
          inputRefs.delete(ordinal);
        }
        const routeRef =
          inputRefs.get(ordinal) ??
          (await this.session.resources.publish(
            'managed-tool-input',
            request.inputBytes,
          ));
        let prepared;
        let executionCallId: string;
        try {
          prepared =
            (request.isShell || request.monitoring) &&
            this.publication &&
            request.argsDigest !== undefined
              ? await this.broker.prepareV3(
                  request.runtimeCallId,
                  request.argsDigest,
                  request.digest,
                  request.publicationId!,
                  // The reserve persists this logical id as the
                  // execution's turn id, exactly what the publisher's
                  // register reference names on the checkpoint axis.
                  this.promptId,
                )
              : null;
          executionCallId =
            prepared?.executionCallId ??
            (await this.broker.prepare(
              request.runtimeCallId,
              request.digest,
              request.inputDigest,
              this.promptId,
            ));
        } catch (cause) {
          if (
            !(cause instanceof HostedWorkspaceBrokerRejection) ||
            cause.status !== 409 ||
            cause.code !== 'runtime_execution_conflict'
          )
            throw cause;
          refusals[ordinal] =
            'Runtime refused this execution reservation before dispatch: ' +
            (cause.reason ?? cause.message).slice(0, 512);
          continue;
        }
        reserved.set(ordinal, executionCallId);
        const toolDefinitionRef =
          definitionRefs.get(ordinal) ??
          (await this.session.resources.publish(
            'managed-tool-definition',
            Buffer.from(
              JSON.stringify(
                declarations.find((tool) => tool.name === request.call.name),
              ),
            ),
          ));
        const authority = this.session.authority;
        const activation = this.session.activation;
        const argsRef =
          request.isShell && !this.publication
            ? await this.session.resources.publish(
                'managed-tool-args',
                Buffer.from(JSON.stringify(request.input)),
              )
            : routeRef;
        const existingIntent =
          restored &&
          authority
            .eventsInSequenceRange(1, authority.committedSequence)
            .find(
              (event) =>
                event.kind === 'tool.intent' &&
                event.payload['executionCallId'] === executionCallId,
            );
        if (
          existingIntent &&
          (existingIntent.payload['batchId'] !== messageId ||
            existingIntent.payload['ordinal'] !== ordinal ||
            !isDeepStrictEqual(existingIntent.payload['argsRef'], argsRef) ||
            !isDeepStrictEqual(
              existingIntent.payload['toolDefinitionRef'],
              toolDefinitionRef,
            ))
        )
          throw new Error('Original prepared intent conflicts.');
        const intent = existingIntent
          ? { lastSequence: existingIntent.sequence }
          : await authority.appendExecutionEvent(
              {
                operation: 'toolIntent',
                commandId: `tool-intent:${executionCallId}`,
                sessionKey: authority.sessionHeader.sessionKey,
                contentDigest: routeRef.digest,
              },
              (sequence) => ({
                v: 1,
                sequence,
                eventId: `tool-intent:${executionCallId}`,
                sessionKey: authority.sessionHeader.sessionKey,
                kind: 'tool.intent',
                occurredAt: Date.now(),
                subject: {
                  type: 'activation',
                  scopeId: activation.activationId,
                  ...activation,
                },
                payload: {
                  executionCallId,
                  batchId: messageId,
                  ordinal,
                  toolDefinitionRef,
                  argsRef,
                  outcomeSource: 'runtime',
                },
              }),
              { class: 'harness', activation },
            );
        if (prepared) {
          shellBindings.set(executionCallId, {
            publicationId: request.publicationId!,
            publicationToken: createToolPublicationToken(),
            runtimeBindingId: prepared.runtimeBindingId,
            bindingGeneration: prepared.bindingGeneration,
            runtimeCallId: request.runtimeCallId,
            // Admitted-after-dropdown shells never hold a loose digest:
            // prepareV3's own gate means a call under the protocol ceiling
            // was refused long before this map gets another entry.
            argsDigest: request.argsDigest as string,
            requestDigest: request.digest,
            argsRef: routeRef,
            intentSequence: intent.lastSequence,
            modelCallId: request.call.callId,
            captureId: randomUUID(),
          });
          // H3: the record intent precedes every physical side effect.
          if (request.background) {
            await this.childRuns!.admit({
              shellId: executionCallId,
              ownerScopeId: authority.sessionHeader.sessionKey.sessionId,
              executionCallId,
              args: request.input,
            });
          }
          if (request.monitoring) {
            await this.monitors!.admit({
              monitorId: executionCallId,
              ownerScopeId: authority.sessionHeader.sessionKey.sessionId,
              executionCallId,
              args: request.input,
              maxEvents: Math.min(
                Math.max((request.input['max_events'] as number) ?? 1_000, 1),
                10_000,
              ),
              idleTimeoutMs: Math.min(
                Math.max(
                  (request.input['idle_timeout_ms'] as number) ?? 300_000,
                  1,
                ),
                600_000,
              ),
              debounceMs: 1_000,
            });
          }
        }
        bindings.push({
          functionCallId: request.call.callId,
          toolName: request.call.name,
          executionCallId,
          invocationBindingId: request.isShell
            ? request.runtimeCallId
            : executionCallId,
          capabilityVersion: WORKSPACE_CAPABILITY_DIGEST,
          policyVersion: 'preapproved-workspace-tools/1',
          mediaVersion: null,
          modelMessageId: messageId,
          partIndex: parts.findIndex(
            (part) => part.functionCall?.id === request.call.callId,
          ),
          ordinal,
          inputDigest:
            request.isShell &&
            this.publication &&
            request.argsDigest !== undefined
              ? request.argsDigest.slice(7)
              : (request.inputDigest ?? request.digest.slice(7)),
          progressCursor: null,
          attemptId: messageId,
          routeRef,
        });
        if (
          (request.isShell || request.monitoring) &&
          this.publisher &&
          // A refused request never funnels its identity: what admissions
          // failed to admit must not be registered either.
          request.validationError === undefined &&
          // A publication lane serves only the detached family: foreground
          // Shell captures stay on the Runtime's publication there.
          (this.shell !== undefined || request.background || request.monitoring)
        ) {
          this.publisher!.register(
            {
              reference: {
                // One pair, two axes: the mapped Broker Runtime Session
                // on the execution axis (a wake turn's arun_…:input maps
                // to wake-<sha256>), the logical prompt id on the
                // checkpoint axis — the execution's own (runtimeSessionId,
                // turnId) is exactly that pair.
                sessionId: this.broker.runtimeSessionId,
                promptId: this.promptId,
                callId: request.runtimeCallId,
                // The worker replays the dispatch reference of the lane the
                // request actually took: a v3 prepare stores and replays the
                // prefixed argsDigest, while the legacy prepare's replay
                // carries the bare input digest. Registration must name the
                // same lane's value or the worker's prepare never matches it.
                argsDigest: prepared
                  ? (request.argsDigest as string)
                  : request.inputDigest!,
              },
              capture: {
                tenantId: authority.sessionHeader.sessionKey.tenantId,
                sessionId: authority.sessionHeader.sessionKey.sessionId,
                turnId: this.promptId,
                executionCallId,
                bindingGeneration: this.bindingGeneration!,
                capturePolicy: 'complete_required',
                ...(request.background ? { background: true } : {}),
                ...(request.monitoring
                  ? { background: true, monitoring: true }
                  : {}),
              },
            },
            request.call.callId,
            // The guard compares the register's reference identity, which
            // is the Runtime identity above; the raw logical promptId only
            // equals it for ids the mapping carries through unchanged.
            this.broker.runtimeSessionId,
          );
        }
      }
      if (bindings.length)
        await this.harness.commitAwaitRuntimeBatch(bindings, {
          turnId: this.promptId,
          promptId: this.promptId,
        });
      // H3: dispatch is durable the moment the checkpoint commits.
      for (const [index, request] of requests.entries()) {
        if (!request.background && !request.monitoring) continue;
        const executionCallId = reserved.get(index)!;
        const saved = shellBindings.get(executionCallId);
        if (!saved) continue;
        const runtime = {
          runtimeBindingId: saved.runtimeBindingId,
          generation: saved.bindingGeneration,
        };
        if (request.background)
          await this.childRuns!.dispatchStarted(executionCallId, runtime);
        if (request.monitoring)
          await this.monitors!.dispatchStarted(executionCallId, runtime);
      }
      if (shellBindings.size > 0) {
        const owner = await this.publication!.owner.owner();
        const authority = this.session.authority;
        const key = authority.sessionHeader.sessionKey;
        const checkpointRef = authority.latestCheckpoint?.stateRef;
        if (!checkpointRef)
          throw new Error('Tool v3 await_runtime checkpoint is missing.');
        for (const [executionCallId, saved] of shellBindings) {
          const binding = {
            publication: 'managed-tool-publication/1',
            publicationId: saved.publicationId,
            sessionKey: key,
            turnId: this.promptId,
            executionCallId,
            modelCallId: saved.modelCallId,
            runtimeBindingId: saved.runtimeBindingId,
            reference: {
              // One pair, two axes, as at the publisher: the mapped
              // Broker Runtime Session against the execution, the logical
              // prompt id against the checkpoint's identity.
              sessionId: this.broker.runtimeSessionId,
              promptId: this.promptId,
              callId: saved.runtimeCallId,
              argsDigest: saved.argsDigest,
            },
            bindingGeneration: saved.bindingGeneration,
            captureId: saved.captureId,
            revision: 1,
            captureScope: 'process_pipes',
            capturePolicy: 'complete_required',
            argsRef: saved.argsRef,
            requestDigest: saved.requestDigest,
            writerId: owner.writerId,
            writerGeneration: owner.writerGeneration,
            activationId: this.session.activation.activationId,
            activationEpoch: this.session.activation.epoch,
            intentSequence: saved.intentSequence,
            checkpointRef,
          };
          const reservation = {
            publication: 'managed-tool-publication/1',
            operation: 'reserve',
            sessionKey: key,
            owner,
            binding,
            captureBytes: this.publication!.captureBytes,
          };
          let grant: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              grant = await this.publication!.owner.request(
                '/grants',
                reservation,
                saved.publicationToken,
              );
              break;
            } catch (cause) {
              const retryable =
                (cause instanceof ManagedSessionStoreHttpError &&
                  (cause.status === 429 || cause.status >= 500)) ||
                cause instanceof TypeError ||
                (cause instanceof DOMException &&
                  ['AbortError', 'TimeoutError'].includes(cause.name));
              if (!retryable || attempt === 2) throw cause;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
          if (
            typeof grant !== 'object' ||
            grant === null ||
            (grant as Record<string, unknown>)['state'] !== 'OPEN'
          )
            throw new Error('Tool publication reservation was not confirmed.');
          saved.originalBinding = parseToolPublicationBinding(binding);
        }
        renewGrants = () => {
          if (renewInFlight) return renewInFlight;
          const pending = (async () => {
            const writer = await this.publication!.owner.owner();
            for (const saved of shellBindings.values()) {
              await this.publication!.owner.request(
                '/grants',
                {
                  publication: 'managed-tool-publication/1',
                  operation: 'renew',
                  sessionKey: key,
                  owner: writer,
                  publicationId: saved.publicationId,
                },
                saved.publicationToken,
              );
            }
          })();
          renewInFlight = pending.finally(() => {
            renewInFlight = null;
          });
          return renewInFlight;
        };
        renewTimer = setInterval(() => {
          void renewGrants!().catch((cause: unknown) => {
            writeStderrLineSafe(
              'qwen serve: Tool publication renewal failed: ' + String(cause),
            );
          });
        }, 10_000);
        renewTimer.unref();
      }
      const responses: Part[] = [];
      // b3b decision 4: the batch's command park names every command call
      // that survived validation; the first of them commits the checkpoint.
      const commandRuns: HarnessCommandWaitRun[] = requests.flatMap(
        (request, index) =>
          request.command && refusals[index] === undefined
            ? [
                {
                  commandId: sessionCommandId({
                    senderSessionId:
                      this.session.authority.sessionHeader.sessionKey.sessionId,
                    promptKey: hostedPromptKey(this.promptId),
                    callId: request.call.callId,
                  }),
                  functionCallId: request.call.callId,
                  toolName: request.call.name,
                  modelMessageId: messageId,
                  folded: false,
                },
              ]
            : [],
      );
      for (const [index, request] of requests.entries()) {
        const refused = refusal(index);
        if (refused) {
          await this.commit('tool_result', refused, model);
          responses.push(...refused);
          continue;
        }
        if (request.agent) {
          responses.push(
            ...(await this.acceptChildAgent(request, model, signal, messageId)),
          );
          continue;
        }
        if (request.message) {
          responses.push(
            ...(await this.acceptSessionMessage(request, model, signal)),
          );
          continue;
        }
        if (request.command) {
          responses.push(
            ...(await this.acceptSessionCommand(
              request,
              model,
              signal,
              commandRuns,
            )),
          );
          continue;
        }
        if (request.skill) {
          const converted = convertToFunctionResponse(
            request.call.name,
            request.call.callId,
            [{ text: this.skills!.response(request.call.args) }],
          );
          if (!this.messageFitsInline('tool_result', converted, model))
            throw new Error(
              'Hosted Skill result exceeds the inline Session Store limit.',
            );
          await this.commit('tool_result', converted, model);
          responses.push(...converted);
          continue;
        }
        if (request.team) {
          responses.push(
            ...(await this.acceptTeamTool(request, model, signal)),
          );
          continue;
        }
        if (request.workflow) {
          responses.push(
            ...(await this.acceptChildWorkflow(
              request,
              model,
              signal,
              messageId,
            )),
          );
          continue;
        }
        const executionCallId = reserved.get(index)!;
        if ((request.isShell || request.monitoring) && this.publication) {
          const saved = shellBindings.get(executionCallId);
          if (!saved) throw new Error('Original Shell publication is missing.');
          await renewGrants!();
          let result: ToolResultEnvelope;
          try {
            result = await this.broker.executeV3(
              executionCallId,
              request.payloadJson,
              saved.publicationId,
              saved.publicationToken,
              signal,
            );
          } catch (failure) {
            if (
              !(failure instanceof HostedWorkspaceBrokerRejection) ||
              failure.status !== 409 ||
              failure.code !== 'runtime_broker_execution_unknown' ||
              !saved.originalBinding
            )
              throw failure;
            const finished = (await this.publication!.owner.request(
              `/publications/${saved.publicationId}/finished`,
              {},
            )) as Record<string, unknown>;
            if (
              !isDeepStrictEqual(
                parseToolPublicationBinding(finished['binding']),
                saved.originalBinding,
              )
            )
              throw new Error('Finished publication binding changed.');
            result = parseToolResultEnvelope(finished['result']);
          }
          if (request.monitoring) {
            responses.push(
              ...(await this.acceptMonitor(
                request,
                executionCallId,
                saved,
                result,
                model,
              )),
            );
          } else if (request.background) {
            responses.push(
              ...(await this.acceptBackgroundShell(
                request,
                executionCallId,
                saved,
                result,
                model,
              )),
            );
          } else {
            responses.push(
              ...(await this.acceptShell(
                request.call,
                executionCallId,
                saved.publicationId,
                saved.publicationToken,
                result,
                model,
              )),
            );
          }
          shellBindings.delete(executionCallId);
          continue;
        }
        const result = await this.broker.execute(
          executionCallId,
          request.payloadJson,
          signal,
          request.isShell
            ? Number(request.input['timeout'] ?? 120000) + 60000
            : this.mcp
              ? 630_000
              : undefined,
          this.mcp !== undefined,
        );
        const shellResult = request.isShell
          ? parseToolResultEnvelope(result)
          : undefined;
        const receipt = shellResult?.capture
          ? await this.publisher!.receipt(executionCallId, shellResult)
          : undefined;
        if (receipt?.deliveryStatus === 'blocked') {
          await this.broker.acknowledge(executionCallId, receipt);
          throw new Error('Complete Shell output was not admitted.');
        }
        const responseParts = result.responseParts as Part[];
        if (
          responseParts.some(
            (part) =>
              !part ||
              typeof part !== 'object' ||
              (typeof part.text !== 'string' &&
                !part.inlineData &&
                !part.fileData),
          )
        )
          throw new Error('Runtime returned an unsupported tool result.');
        const modelParts = shellResult?.capture?.previewTruncated
          ? [
              {
                text: `Shell execution: ${shellResult.executionStatus}. Output preview is truncated. Complete stdout and stderr are retained in the Session result.`,
              },
              ...responseParts,
            ]
          : responseParts;
        let converted =
          result.executionStatus === 'success'
            ? convertToFunctionResponse(
                request.call.name,
                request.call.callId,
                modelParts,
              )
            : convertToFunctionErrorResponse(
                request.call.name,
                request.call.callId,
                modelParts,
                result.error?.message ??
                  `Runtime tool ${result.executionStatus}.`,
              );
        const response = converted[0]?.functionResponse;
        if (!response || converted.length !== 1)
          throw new Error('Runtime result cannot be represented durably.');
        response.response = {
          ...response.response,
          executionStatus: result.executionStatus,
          ...(result.error ? { runtimeError: result.error } : {}),
          ...(shellResult ? { capture: shellResult.capture } : {}),
        };
        let outcome = Buffer.from(
          JSON.stringify({ executionCallId, ...converted[0] }),
        );
        if (
          outcome.byteLength >
            HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes ||
          !this.messageFitsInline('tool_result', converted, model)
        ) {
          // A glob result is a path list: keep the prefix that fits rather
          // than omitting the whole result, so the model can narrow and retry.
          if (request.call.name === 'glob') {
            const fits = (candidate: Part[]) =>
              Buffer.byteLength(
                JSON.stringify({ executionCallId, ...candidate[0] }),
              ) <= HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes &&
              this.messageFitsInline('tool_result', candidate, model);
            const truncated = truncateHostedGlobResponse(converted, fits);
            if (truncated) {
              converted = truncated;
              outcome = Buffer.from(
                JSON.stringify({ executionCallId, ...converted[0] }),
              );
            }
          }
        }
        if (
          outcome.byteLength >
            HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes ||
          !this.messageFitsInline('tool_result', converted, model)
        ) {
          if (receipt)
            throw new Error(
              'Admitted Shell result exceeds the inline Session Store limit.',
            );
          converted = [
            {
              functionResponse: {
                id: request.call.callId,
                name: request.call.name,
                response: {
                  error:
                    `Tool execution settled as ${result.executionStatus}, but its output exceeds the ${HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes}-byte durable Session limit and was omitted.` +
                    (request.call.name === 'read_file'
                      ? ' Request a smaller offset/limit range.'
                      : ''),
                  executionStatus: result.executionStatus,
                  outputOmitted: true,
                },
              },
            },
          ];
          outcome = Buffer.from(
            JSON.stringify({ executionCallId, ...converted[0] }),
          );
        }
        const outcomeRef =
          receipt?.outcomeRef ??
          (await this.session.resources.publish(
            'managed-tool-outcome',
            outcome,
          ));
        await this.commit('tool_result', converted, model);
        await this.harness.resolveAwaitRuntime(executionCallId, outcomeRef);
        if (receipt) await this.broker.acknowledge(executionCallId, receipt);
        responses.push(...converted);
      }
      if (paths.length) {
        const state = await this.broker.fileHistory({
          kind: 'raw-file-history',
          action: 'snapshot',
        });
        await commitHostedFileHistory(this.session, {
          schemaVersion: 1,
          state,
          pendingTurn: null,
          pendingUndo: null,
        });
      }
      this.uncertain = false;
      return responses;
    } catch (cause) {
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = undefined;
      }
      const activeRenewal = renewInFlight as Promise<void> | null;
      await activeRenewal?.catch(() => undefined);
      const cancellationBarriers = new Set<string>();
      const reservedIds = [...reserved.values()];
      const cancellationResults = await Promise.allSettled(
        reservedIds.map((id) => this.broker.cancel(id)),
      );
      cancellationResults.forEach((result, index) => {
        if (result.status === 'fulfilled')
          cancellationBarriers.add(reservedIds[index]!);
      });
      for (const executionCallId of shellBindings.keys()) {
        const saved = shellBindings.get(executionCallId);
        if (!saved) continue;
        const request = requests.find(
          (_, index) => reserved.get(index) === executionCallId,
        );
        let proven = false;
        let grantOwnerState: unknown;
        try {
          const owner = this.publication!.owner;
          const closed = await owner.request(
            '/grants',
            {
              publication: 'managed-tool-publication/1',
              operation: 'close_not_started',
              sessionKey: this.session.authority.sessionHeader.sessionKey,
              owner: await owner.owner(),
              publicationId: saved.publicationId,
            },
            saved.publicationToken,
          );
          if (typeof closed === 'object' && closed !== null)
            grantOwnerState = (closed as Record<string, unknown>)['state'];
          if (grantOwnerState !== 'NOT_STARTED')
            throw new Error('Original execution was not proven unstarted.');
          proven = true;
        } catch (closeCause) {
          writeStderrLineSafe(
            'qwen serve: Tool publication close was not confirmed: ' +
              String(closeCause),
          );
        }
        if (
          !proven &&
          grantOwnerState === undefined &&
          request?.background &&
          cancellationBarriers.has(executionCallId)
        ) {
          try {
            proven =
              (await this.broker.backgroundProcessStatus(executionCallId)) ===
              undefined;
          } catch (cause) {
            writeStderrLineSafe(
              `qwen serve: Background process absence could not be confirmed for ${executionCallId} (${rejectionDetail(cause)}).`,
            );
          }
        }
        if (!proven) continue;
        // The grant owner proved a Shell or Monitor start never happened,
        // or the original process ledger proved it for a background Shell.
        // Publication absence alone proves nothing.
        if (request?.background)
          await this.childRuns
            ?.settleFailed(executionCallId, {
              stopReason: 'start_failed',
              started: false,
            })
            .catch((settleCause: unknown) =>
              writeStderrLineSafe(
                'qwen serve: Unstarted child run record was not settled: ' +
                  String(settleCause),
              ),
            );
        if (request?.monitoring)
          await this.monitors
            ?.settleFailed(executionCallId, {
              stopReason: 'start_failed',
              started: false,
            })
            .catch((settleCause: unknown) =>
              writeStderrLineSafe(
                'qwen serve: Unstarted monitor run record was not settled: ' +
                  String(settleCause),
              ),
            );
      }
      throw new HostedToolRecoveryRequiredError(cause);
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      const activeRenewal = renewInFlight as Promise<void> | null;
      await activeRenewal?.catch(() => undefined);
    }
  }

  private encodeToolInput(payload: {
    toolName: string;
    input: unknown;
  }): HostedEncodedToolInput {
    const payloadJson = JSON.stringify(payload);
    const inputBytes = Buffer.from(
      JSON.stringify({
        harnessSessionId:
          this.session.authority.sessionHeader.sessionKey.sessionId,
        runtimeSessionId: this.broker.runtimeSessionId,
        payloadJson,
      }),
    );
    if (
      inputBytes.length >
      HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
    )
      throw new HostedToolInputInlineLimitError();
    return {
      payloadJson,
      inputBytes,
      digest: `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`,
    };
  }

  /**
   * H3 Monitor watch settlement, the mirror of acceptBackgroundShell: an
   * unstarted refuse settles start_failed on the record; a settled
   * detached handle lands blocked with no second journal receipt, and the
   * watch's physical start attaches through the same idempotent rule —
   * a journaled receipt verdict first, attach only when this identity
   * still lacks its start receipt.
   */
  private async acceptMonitor(
    request: {
      call: ToolCallRequestInfo;
      input: Record<string, unknown>;
    },
    executionCallId: string,
    saved: {
      publicationId: string;
      publicationToken: string;
      runtimeBindingId: string;
      bindingGeneration: string;
      runtimeCallId: string;
    },
    result: ToolResultEnvelope,
    model: string,
  ): Promise<Part[]> {
    if (result.executionStatus === 'not_started' && result.capture === null) {
      // Prove before settle: the owner's close gate is the authority on
      // "this start never happened". Settling the record first and then
      // seeing the proof refused would freeze a run that actually started
      // into a line no later fact may ever touch.
      const parts = await this.acceptShell(
        request.call,
        executionCallId,
        saved.publicationId,
        saved.publicationToken,
        result,
        model,
      );
      await this.monitors!.settleFailed(executionCallId, {
        stopReason: 'start_failed',
        started: false,
      });
      return parts;
    }
    if (
      result.executionStatus !== 'success' ||
      result.capture?.captureStatus !== 'detached'
    ) {
      throw new Error(
        `Monitor watch settled with an unexpected result shape (${result.executionStatus}).`,
      );
    }
    const authority = this.session.authority;
    let receipt = authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'tool.receipt' &&
          event.payload['executionCallId'] === executionCallId,
      );
    if (receipt === undefined) {
      const existing = this.monitors!.record(executionCallId);
      if (existing === undefined || existing.startReceiptRef === null) {
        await this.monitors!.attach(
          executionCallId,
          {
            runtimeBindingId: saved.runtimeBindingId,
            generation: saved.bindingGeneration,
          },
          {
            executionCallId,
            runtimeCallId: saved.runtimeCallId,
            unitName: `qwen-mon-${saved.runtimeCallId.replace(/[^a-zA-Z0-9._-]/g, '-')}`,
            bindingGeneration: saved.bindingGeneration,
            occurredAt: Date.now(),
          },
        );
      }
      // A watch that ended before this attach left its finalize refused:
      // with the start receipt now committed, its own settle — tail
      // observation included — completes without any client retry.
      await this.publisher?.settleAttached(executionCallId);
    }
    // The observation lifecycle lives exactly once per owning process,
    // keyed on the live record rather than on this call's freshness: a
    // fresh accept starts it, and a replay after a restart — whose
    // journal already carries the receipt — must resume it, or the
    // watch's lines, terminal conditions and settle never arrive.
    const monitorRecord = this.monitors!.record(executionCallId);
    // A parked watch has stopReason null like a live one, but its quota or
    // idle window already ended it as unproven — resuming it would commit a
    // post-quota observation the record refuses, silently. Only a live
    // record is resumed (#13856 R1-55).
    if (
      monitorRecord?.stopReason === null &&
      monitorRecord.run.state !== 'recovery_blocked'
    ) {
      await this.resumeMonitorWatch(executionCallId, saved.runtimeCallId);
    }
    let ref: ManagedSessionDurableRef;
    let converted: Part[];
    let messageId: string;
    let timestamp: string;
    if (receipt) {
      ref = assertManagedSessionDurableRef(
        receipt.payload['toolOutcomeRef'],
        'original tool outcome',
      );
      const savedResult = JSON.parse(
        (await this.session.resources.read(ref)).toString('utf8'),
      ) as Record<string, unknown>;
      const history = savedResult['history'] as
        | Record<string, unknown>
        | undefined;
      if (
        savedResult['schemaVersion'] !== 1 ||
        savedResult['decision'] !== 'blocked' ||
        !isDeepStrictEqual(savedResult['envelope'], result) ||
        savedResult['manifestRef'] !== null ||
        receipt.payload['resultRef'] !== null ||
        (receipt.payload['resources'] !== undefined &&
          !isDeepStrictEqual(receipt.payload['resources'], [])) ||
        receipt.payload['historyRevision'] !== receipt.sequence ||
        typeof history?.['messageId'] !== 'string' ||
        typeof history['timestamp'] !== 'string' ||
        typeof history['model'] !== 'string' ||
        !Array.isArray(history['parts'])
      )
        throw new Error('Original Monitor watch receipt conflicts.');
      converted = history['parts'] as Part[];
      messageId = history['messageId'] as string;
      timestamp = history['timestamp'] as string;
      model = history['model'] as string;
    } else {
      converted = convertToFunctionResponse(
        request.call.name,
        request.call.callId,
        result.responseParts as Part[],
      );
      const response = converted[0]?.functionResponse;
      if (!response || converted.length !== 1)
        throw new Error('Monitor watch result cannot be recorded.');
      response.response = {
        ...response.response,
        executionStatus: 'success',
      };
      if (!this.messageFitsInline('tool_result', converted, model))
        throw new Error('Monitor watch result cannot be recorded.');
      const originalIntent = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.intent' &&
            event.payload['executionCallId'] === executionCallId,
        );
      if (!originalIntent)
        throw new Error('Original Monitor watch intent is missing.');
      messageId = shellHistoryId(executionCallId);
      timestamp = new Date(originalIntent.occurredAt).toISOString();
      const outcome = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          decision: 'blocked',
          envelope: result,
          manifestRef: null,
          history: { messageId, timestamp, model, parts: converted },
        }),
      );
      if (
        outcome.byteLength >
        HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
      )
        throw new Error('Monitor watch outcome exceeds its limit.');
      ref = await this.session.resources.publish(
        'managed-tool-outcome',
        outcome,
      );
      await authority.appendExecutionEvent(
        {
          operation: 'recordToolResult',
          commandId: executionCallId,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: ref.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `tool-receipt:${executionCallId}`,
          sessionKey: authority.sessionHeader.sessionKey,
          kind: 'tool.receipt',
          occurredAt: Date.now(),
          payload: {
            executionCallId,
            toolOutcomeRef: ref,
            resultRef: null,
            resources: [],
            historyRevision: sequence,
          },
        }),
        { class: 'trusted_entry' },
      );
      receipt = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.receipt' &&
            event.payload['executionCallId'] === executionCallId,
        );
    }
    if (!receipt)
      throw new Error('Original Monitor watch receipt disappeared.');
    await this.commit('tool_result', converted, model, {
      uuid: messageId,
      timestamp,
    });
    await this.harness.resolveAwaitRuntime(executionCallId, ref);
    try {
      await this.broker.acknowledgeV3(executionCallId, {
        executionCallId,
        manifest: null,
        deliveryStatus: 'blocked',
        historyRevision: null,
      });
    } catch (cause) {
      throw new Error(
        `Monitor watch acknowledgement failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return converted;
  }

  /**
   * One derivation of the child run id shared by the launcher and the
   * recovery probe: a wake turn's turn id already embeds its
   * commissioning child run (`<childRunId>:accept:notify`), so using it
   * verbatim as the launch base grows the next run id one suffix per hop
   * and walks a chained helper into the 128-char lineage bound by the
   * third hop. The replay-stable key needs determinism, not readability:
   * collapse the wake turn's identity to a bounded digest of its own
   * stable name — never grow across hops, always 17 chars plus the call
   * id. Calls keyed verbatim for every other turn — re-driven batches
   * and resumed Hook results both name the same run again and again.
   */
  private childRunIdFor(callId: string): string {
    return hostedChildRunIdFor(this.promptId, callId);
  }

  /** The message id one send_message call mints, replay-stable. */
  private messageIdFor(callId: string): string {
    return sessionMessageId({
      senderSessionId:
        this.session.authority.sessionHeader.sessionKey.sessionId,
      turnId: this.promptId,
      callId,
    });
  }

  /**
   * H4d-b: commit one `send_message` and answer the call. The message only
   * opens its sender's outbox entry (or a continuation launch); the control
   * plane's relay hands it over, so nothing here waits on the target.
   * A re-driven batch names the same message or continuation again.
   */
  private async acceptSessionMessage(
    request: { call: ToolCallRequestInfo },
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const answer = async (text: string, failed: boolean): Promise<Part[]> => {
      const parts = failed
        ? convertToFunctionErrorResponse(
            request.call.name,
            request.call.callId,
            [],
            text,
          )
        : convertToFunctionResponse(request.call.name, request.call.callId, [
            { text },
          ]);
      await this.commit('tool_result', parts, model);
      return parts;
    };
    if (signal.aborted) {
      return answer(
        'The turn was cancelled before this message was sent.',
        true,
      );
    }
    const authority = this.session.authority;
    const text = request.call.args['message'] as string;
    const messageId = this.messageIdFor(request.call.callId);
    const callKey = this.childRunIdFor(request.call.callId);
    if (this.messages!.lineage !== undefined) {
      try {
        await this.messages!.sendToParent({
          text,
          messageId,
          executionCallId: callKey,
          closing: authority.currentActivation?.phase !== 'active',
        });
      } catch (cause) {
        if (!isMessageRefusal(cause)) throw cause;
        return answer(
          `The message to the parent was refused: ${cause.message}`,
          true,
        );
      }
      this.agentDispatched.add(request.call.callId);
      return answer(HOSTED_MESSAGE_TO_PARENT_TEXT, false);
    }
    if (typeof request.call.args['to'] === 'string') {
      return this.acceptTeamMessage(
        request,
        request.call.args['to'],
        text,
        answer,
        signal,
      );
    }
    const taskId = (request.call.args['task_id'] as string).trim();
    let route: Awaited<ReturnType<HostedChildAgentSession['sendToChild']>>;
    try {
      route = await this.childAgents!.sendToChild({
        taskId,
        text,
        messageId,
        continuationRunId: callKey,
        executionCallId: callKey,
        closing: authority.currentActivation?.phase !== 'active',
        childWorkspaces: this.childWorkspaces,
      });
    } catch (cause) {
      if (!isMessageRefusal(cause)) throw cause;
      return answer(`The message was refused: ${cause.message}`, true);
    }
    if (route.kind === 'refused') return answer(route.reason, true);
    this.agentDispatched.add(request.call.callId);
    // A member addressed by its task id is answered as one (H4e-b2).
    return answer(hostedRouteAnswer(this.childAgents!, route), false);
  }

  /**
   * H4e-b2 decisions 3 and 4: the lead's `send_message` to a member by
   * name, or to every member with "*". A name routes exactly as the task
   * id of the member's first run does, under the ids the task_id form
   * mints for the call; each broadcast recipient has its own ids, where no
   * single send or launch can reach them. A replay finds what the call
   * committed before it resolves `to`, so it answers the committed send
   * even after the team has changed.
   */
  private async acceptTeamMessage(
    request: { call: ToolCallRequestInfo },
    to: string,
    text: string,
    answer: (text: string, failed: boolean) => Promise<Part[]>,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const children = this.childAgents!;
    const teams = this.teams!;
    const { callId } = request.call;
    const callKey = this.childRunIdFor(callId);
    const closing =
      this.session.authority.currentActivation?.phase !== 'active';
    const send = async (
      taskId: string,
      messageId: string,
      continuationRunId: string,
    ): Promise<HostedChildMessageRoute> => {
      try {
        return await children.sendToChild({
          taskId,
          text,
          messageId,
          continuationRunId,
          executionCallId: callKey,
          closing,
          childWorkspaces: this.childWorkspaces,
        });
      } catch (cause) {
        if (!isMessageRefusal(cause)) throw cause;
        return { kind: 'refused', reason: cause.message };
      }
    };
    if (isBroadcast(to)) {
      const senderSessionId =
        this.session.authority.sessionHeader.sessionKey.sessionId;
      const team = teams.openTeam();
      const committed = hostedBroadcastAnyCommitted({
        children,
        messages: this.messages,
        senderSessionId,
        promptId: this.promptId,
        callId,
      })
        ? hostedBroadcastCommitted({
            authority: this.session.authority,
            children,
            messages: this.messages,
            senderSessionId,
            promptId: this.promptId,
            callId,
          })
        : [];
      // A replay sends only to the roster the first run read: the batch
      // rule keeps it unchanged, so a team deleted or replaced since means
      // the broadcast answers for the recipients it reached and sends to
      // nobody new.
      if (
        committed.length > 0 &&
        (team === undefined ||
          committed.some(
            (each) =>
              team.members[each.position - 1]?.childRunId !==
              each.rootChildRunId,
          ))
      ) {
        this.agentDispatched.add(callId);
        return answer(
          `The message was sent to ${committed.length} member${committed.length === 1 ? '' : 's'} before its team changed; nothing more was sent.\n${committed
            .map(
              (each) =>
                `- ${each.name ?? `position ${each.position}`}: ${each.text}`,
            )
            .join('\n')}`,
          false,
        );
      }
      if (team === undefined)
        return answer(
          'No open team: create one with team_create, or address a child agent by task_id.',
          true,
        );
      if (team.members.length === 0)
        return answer(`Team "${team.name}" has no members yet.`, true);
      const lines: string[] = [];
      // Sent: the call committed a send to the member. Arrived: that send
      // did not reach a run that proved it never started, nor did its
      // delivery fail, which only a replay can find.
      let sent = 0;
      let arrived = 0;
      let unconfirmed = 0;
      // A cancelled Turn sends to no further member: each send may launch
      // a continuation, which spends the Session's launches.
      let cancelled = false;
      const committedByPosition = new Map(
        committed.map((each) => [each.position, each]),
      );
      for (const [index, member] of team.members.entries()) {
        const position = index + 1;
        const replayed = committedByPosition.get(position);
        if (replayed !== undefined) {
          sent += 1;
          if (replayed.arrived) arrived += 1;
          if (replayed.unconfirmed) unconfirmed += 1;
          lines.push(`- ${member.name}: ${replayed.text}`);
          continue;
        }
        if (signal.aborted) {
          cancelled = true;
          lines.push(`- ${member.name}: not sent: the turn was cancelled.`);
          continue;
        }
        const route = await send(
          children.taskIdOf(member.childRunId),
          broadcastMessageId({
            senderSessionId,
            turnId: this.promptId,
            callId,
            position,
          }),
          broadcastRunId(this.promptId, callId, position),
        );
        if (route.kind !== 'refused') {
          sent += 1;
          if (hostedRouteArrived(route)) arrived += 1;
          if (hostedRouteUnconfirmed(route)) unconfirmed += 1;
        }
        lines.push(`- ${member.name}: ${hostedRouteLine(children, route)}`);
      }
      if (sent === 0)
        return answer(
          `The message reached no member:\n${lines.join('\n')}`,
          true,
        );
      this.agentDispatched.add(callId);
      const notArrived = sent - arrived - unconfirmed;
      return answer(
        arrived === team.members.length
          ? `Message sent to every member of team "${team.name}". There is no inline reply: each member answers through its result notification or a message to you.\n${lines.join('\n')}`
          : `Message sent to ${sent} of ${team.members.length} members of team "${team.name}"${notArrived > 0 ? `, but it did not arrive at ${notArrived} of them` : ''}${unconfirmed > 0 ? `; delivery could not be confirmed for ${unconfirmed}` : ''}${cancelled ? `; the turn was cancelled before the rest` : ''}. Send it by name only to a member whose line says it did not get it, that can still take messages, and still needs it.${unconfirmed > 0 ? ' Check with a member before resending any unconfirmed delivery.' : ''}\n${lines.join('\n')}`,
        false,
      );
    }
    const messageId = this.messageIdFor(callId);
    if (
      this.messages!.message(messageId) !== undefined ||
      children.record(callKey) !== undefined
    ) {
      // The replay: sendToChild answers the committed send by its ids.
      // The name and its label hold only while the member's team is open;
      // a former member's continuation is a plain child (decision 6).
      const route = await send('', messageId, callKey);
      if (route.kind === 'refused') return answer(route.reason, true);
      this.agentDispatched.add(callId);
      return answer(hostedRouteAnswer(children, route), false);
    }
    const team = teams.openTeam();
    if (team === undefined)
      return answer(
        'No open team: create one with team_create, or address a child agent by task_id.',
        true,
      );
    const name = sanitizeName(to);
    if (name === MANAGED_TEAM_LEADER)
      return answer(
        'You are the team leader: "to" names a member, or "*" for every member.',
        true,
      );
    const member = team.members.find((each) => each.name === name);
    if (member === undefined)
      return answer(
        `"${to}" is not a member of team "${team.name}". ${team.members.length > 0 ? `Members: ${team.members.map((each) => each.name).join(', ')}.` : 'It has no members yet.'}`,
        true,
      );
    const route = await send(
      children.taskIdOf(member.childRunId),
      messageId,
      callKey,
    );
    if (route.kind === 'refused')
      return answer(
        `The message to member "${name}" was refused: ${route.reason}`,
        true,
      );
    this.agentDispatched.add(callId);
    return answer(hostedRouteAnswer(children, route), false);
  }

  /**
   * H4b: launch one child Session and complete the call through its own
   * arm. The intent commits before any physical effect; the control
   * plane's relay owns creation and delivery from there. The launch is
   * replay-safe by its derived record key: a re-driven batch names the
   * same child Run id, so nothing creates a second child Session.
   */
  private async acceptChildAgent(
    request: {
      call: ToolCallRequestInfo;
      agentBackground: boolean;
    },
    model: string,
    signal: AbortSignal,
    modelMessageId: string,
  ): Promise<Part[]> {
    // A cancelled turn admits nothing further: keeping an already-launched
    // child running is documented, but a batch that re-enters here after
    // its abort (a sibling's abandoned wait returned control) must not
    // stamp a new child the cancelled turn never started.
    if (signal.aborted) {
      const skipped = convertToFunctionErrorResponse(
        request.call.name,
        request.call.callId,
        [],
        HOSTED_AGENT_CALL_NOT_ADMITTED_TEXT,
      );
      await this.commit('tool_result', skipped, model);
      return skipped;
    }
    const children = this.childAgents!;
    const authority = this.session.authority;
    const key = authority.sessionHeader.sessionKey;
    const description = (request.call.args['description'] as string).trim();
    const prompt = request.call.args['prompt'] as string;
    const childRunId = this.childRunIdFor(request.call.callId);
    // The v1 pin: the parent's own definition, documented by its
    // definition resource's digest (the control plane reads the pin from
    // the committed body when it stamps the child's lineage).
    const definition = {
      definitionId: `hosted-agent/${this.profile ?? 'unknown'}`,
      definitionRevision: 1,
      definitionDigest: authority.sessionHeader.definitionRef.digest,
    };
    // H4e-b1: a named launch is a team member. Its team checks run before
    // the launch commits anything; a replay whose run is already on the
    // roster has nothing left to join, and one whose team changed since
    // still answers for the child it launched.
    const rawName = request.call.args['name'];
    let member: HostedTeamMembership | undefined;
    let joining = false;
    let unjoined: string | undefined;
    if (typeof rawName === 'string') {
      member = this.teams!.membership(childRunId);
      if (member === undefined) {
        try {
          member = this.teams!.admitMember(rawName);
          joining = true;
        } catch (cause) {
          if (!(cause instanceof HostedTeamRefusal)) throw cause;
          if (children.record(childRunId) === undefined) {
            const refused = convertToFunctionErrorResponse(
              request.call.name,
              request.call.callId,
              [],
              cause.message,
            );
            await this.commit('tool_result', refused, model);
            return refused;
          }
          unjoined = cause.message;
        }
      }
    }
    // H4e-b2 decision 5: a member's launch prompt opens with its preamble,
    // part of the envelope and so of its bound. A replay goes on with the
    // committed envelope, whose preamble may follow a team changed since.
    // H4e-b3 decision 9: the plan-mode attribute follows the roster entry —
    // a fresh join has none in this build; a re-driven launch reads it.
    const launchPrompt =
      member === undefined
        ? prompt
        : teamMemberPreamble(
            member,
            joining
              ? request.call.args['plan_mode_required'] === true
              : this.teams!.memberPlanMode(member),
          ) + prompt;
    // The envelope bound is enforced by the admission's byte_limit
    // refusal — but the encoder throws a size error before that branch
    // can ever answer. Translate the throw into the same refusal: an
    // over-size prompt is a model-correctable argument error, never a
    // recovery-blocked Turn.
    let envelopeBytes: number;
    try {
      envelopeBytes = encodeChildLaunchEnvelope({
        description,
        prompt: launchPrompt,
        definition,
      }).byteLength;
    } catch (cause) {
      if (!(cause instanceof ManagedSessionRecordError)) throw cause;
      envelopeBytes = Number.POSITIVE_INFINITY;
    }
    // Quotas gate NEW children only: a re-driven batch names the same
    // run id, and `children.admit` answers that replay identically —
    // counting the replayed child against `count_limit` or the launch
    // budget would refuse the launch it is already running. Both counts
    // read committed records only, so a refusal re-derives on replay.
    // #13753 I2: the launch's isolation, fixed on its record for every
    // later revision and replay.
    const workspaceMode =
      request.call.args['isolation'] === 'worktree' ? 'worktree' : 'shared';
    if (children.record(childRunId) === undefined) {
      const admission = childLaunchAdmission({
        workspaceMode,
        childWorkspaces: this.childWorkspaces,
        sameDefinition: true,
        closing: authority.currentActivation?.phase !== 'active',
        activeInScope: children.activeChildRunsOf(key.sessionId).length,
        launchedInScope: children.launchedChildRunsOf(key.sessionId).length,
        envelopeBytes,
      });
      if (!admission.admitted) {
        const refused = convertToFunctionErrorResponse(
          request.call.name,
          request.call.callId,
          [],
          admission.reason === 'workspace_mode'
            ? 'Hosted child agent refused this launch (workspace_mode): this host does not serve isolated child Workspaces; launch without isolation to share this Workspace.'
            : `Hosted child agent refused this launch (${admission.reason}).`,
        );
        await this.commit('tool_result', refused, model);
        return refused;
      }
    }
    const launched = await children.admit({
      childRunId,
      ownerScopeId: key.sessionId,
      rootSessionId: key.sessionId,
      completion: request.agentBackground ? 'sent' : 'tool',
      description,
      prompt: launchPrompt,
      sentPrompt: prompt,
      definition,
      workspaceMode,
      workingDirectory: '.',
      executionCallId: childRunId,
    });
    this.agentDispatched.add(request.call.callId);
    if (!request.agentBackground) {
      // The durable wait (#13708): a restarted Harness re-enters it from
      // the checkpoint instead of declining the parked Turn. The intent
      // ledger above is the evidence; this checkpoint is what recovery
      // classifies, committed immediately after the admission so the
      // uncovered window is two statements (the same shape the Runtime
      // batch accepts between its intents and commitAwaitRuntimeBatch).
      await this.harness.commitAwaitAgent(
        [
          {
            childRunId,
            functionCallId: request.call.callId,
            toolName: request.call.name,
            modelMessageId,
            consumed: false,
          },
        ],
        { turnId: this.promptId, promptId: this.promptId },
        { attemptId: modelMessageId, routeRef: launched.inputRef },
      );
      return await this.awaitChildToolResult(
        children,
        request,
        childRunId,
        model,
        signal,
      );
    }
    const taskId = managedChildTaskId(key.sessionId, childRunId);
    if (member !== undefined && joining) {
      const joined = await this.teams!.join({
        teamId: member.teamId,
        name: member.name,
        childRunId,
        planModeRequired: request.call.args['plan_mode_required'] === true,
      });
      if ('ended' in joined) {
        // A run that finished first still delivers its result, unlabeled.
        const ended =
          joined.ended.run.state === 'settled'
            ? convertToFunctionResponse(
                request.call.name,
                request.call.callId,
                [
                  {
                    text: `Child agent ${taskId} finished before it joined team "${member.teamName}", so the name "${member.name}" stays free; its result arrives as an ordinary notification.`,
                  },
                ],
              )
            : convertToFunctionErrorResponse(
                request.call.name,
                request.call.callId,
                [],
                `Child agent ${taskId} ended (${joined.ended.run.state}, ${joined.ended.stopReason ?? 'unknown'}) before it joined team "${member.teamName}", so the name "${member.name}" stays free.`,
              );
        await this.commit('tool_result', ended, model);
        return ended;
      }
    }
    const membership =
      member === undefined
        ? unjoined === undefined
          ? ''
          : ` It did not join the team: ${unjoined}`
        : hostedTeamJoinedText(member);
    const started = convertToFunctionResponse(
      request.call.name,
      request.call.callId,
      [
        {
          text:
            hostedChildBackgroundStartedText('child_agent', taskId) +
            membership,
        },
      ],
    );
    await this.commit('tool_result', started, model);
    return started;
  }

  /**
   * The workflow launch of the batch (#13803 K1): the same discipline as
   * {@link acceptChildAgent}, with the script-derived pin opening the chain
   * and the workflow envelope as the launch evidence.
   */
  private async acceptChildWorkflow(
    request: {
      call: ToolCallRequestInfo;
      agentBackground: boolean;
    },
    model: string,
    signal: AbortSignal,
    modelMessageId: string,
  ): Promise<Part[]> {
    if (signal.aborted) {
      const skipped = convertToFunctionErrorResponse(
        request.call.name,
        request.call.callId,
        [],
        'The turn was cancelled before this workflow was admitted.',
      );
      await this.commit('tool_result', skipped, model);
      return skipped;
    }
    const children = this.childAgents!;
    const authority = this.session.authority;
    const key = authority.sessionHeader.sessionKey;
    const script = request.call.args['script'] as string;
    const args = request.call.args['args'];
    const childRunId = this.childRunIdFor(request.call.callId);
    // The launch pin (decision 2): computed from the exact script bytes
    // that ride the envelope — the child re-verifies before it runs.
    const definition = workflowDefinitionPin(script);
    let envelopeBytes: number;
    try {
      envelopeBytes = encodeWorkflowLaunchEnvelope({
        definition,
        script,
        args: args ?? null,
      }).byteLength;
    } catch (cause) {
      if (!(cause instanceof ManagedSessionRecordError)) throw cause;
      envelopeBytes = Number.POSITIVE_INFINITY;
    }
    if (children.record(childRunId) === undefined) {
      const admission = childLaunchAdmission({
        workspaceMode: 'shared',
        childWorkspaces: false,
        sameDefinition: true,
        closing: authority.currentActivation?.phase !== 'active',
        activeInScope: children.activeChildRunsOf(key.sessionId).length,
        launchedInScope: children.launchedChildRunsOf(key.sessionId).length,
        envelopeBytes,
      });
      if (!admission.admitted) {
        const refused = convertToFunctionErrorResponse(
          request.call.name,
          request.call.callId,
          [],
          `Hosted workflow refused this launch (${admission.reason}).`,
        );
        await this.commit('tool_result', refused, model);
        return refused;
      }
    }
    const launched = await children.admitWorkflow({
      childRunId,
      ownerScopeId: key.sessionId,
      rootSessionId: key.sessionId,
      completion: request.agentBackground ? 'sent' : 'tool',
      script,
      args: args ?? null,
      definition,
      workingDirectory: '.',
      executionCallId: childRunId,
    });
    this.agentDispatched.add(request.call.callId);
    if (!request.agentBackground) {
      // The durable wait (#13708), parked exactly as acceptChildAgent parks
      // it: without it a Harness restart declines this Turn with
      // unresolved_after_settle while the child keeps running.
      await this.harness.commitAwaitAgent(
        [
          {
            childRunId,
            functionCallId: request.call.callId,
            toolName: request.call.name,
            modelMessageId,
            consumed: false,
          },
        ],
        { turnId: this.promptId, promptId: this.promptId },
        { attemptId: modelMessageId, routeRef: launched.inputRef },
      );
      return await this.awaitChildToolResult(
        children,
        request,
        childRunId,
        model,
        signal,
      );
    }
    const taskId = managedChildTaskId(key.sessionId, childRunId);
    const started = convertToFunctionResponse(
      request.call.name,
      request.call.callId,
      [{ text: hostedChildBackgroundStartedText('workflow', taskId) }],
    );
    await this.commit('tool_result', started, model);
    return started;
  }

  /**
   * The recovered arm of the foreground wait (#13708): re-enter the poll
   * the dead owner's awaitChildToolResult ran, for every run the checkpoint
   * still owes. Exactly-once rides the journaled set, never the process:
   * a replayed resume meets the run's already-committed tool_result and
   * skips only the commit — the acceptance and the resolve are themselves
   * replay-safe and must still run so the wait leaves its consumed marker.
   */
  async resumeAgentWaitRuns(
    runs: readonly HarnessAgentWaitRun[],
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const children = this.childAgents;
    if (children === undefined)
      throw new Error('Recovered agent wait has no child agent funnel.');
    const journaled = await journaledToolResultIds(this.session, this.promptId);
    for (const run of runs) {
      if (run.consumed) continue;
      await this.awaitChildToolResult(
        children,
        { call: { name: run.toolName, callId: run.functionCallId } },
        run.childRunId,
        model,
        signal,
        journaled,
      );
    }
  }

  /**
   * H4e-b1: one team tool call, run by the Session's team funnel against
   * the committed team and board. A refusal answers the call as its error
   * and commits nothing; nothing here touches the Workspace.
   */
  private async acceptTeamTool(
    request: { call: ToolCallRequestInfo },
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const { name, callId, args } = request.call;
    if (signal.aborted) {
      const skipped = convertToFunctionErrorResponse(
        name,
        callId,
        [],
        'The turn was cancelled before this tool call ran.',
      );
      await this.commit('tool_result', skipped, model);
      return skipped;
    }
    let answer: (text: string) => Part[];
    let text: string;
    try {
      text = await this.teams!.run(
        name,
        args,
        this.childRunIdFor(callId),
        `${hostedPromptKey(this.promptId)}:`,
        {
          closing: this.session.authority.currentActivation?.phase !== 'active',
          childWorkspaces: this.childWorkspaces,
        },
      );
      answer = (each) =>
        convertToFunctionResponse(name, callId, [{ text: each }]);
    } catch (cause) {
      if (!(cause instanceof HostedTeamRefusal)) throw cause;
      text = cause.message;
      answer = (each) => convertToFunctionErrorResponse(name, callId, [], each);
    }
    // A long board folds to the inline bound with its marker; the fit
    // predicate, not an estimate, measures the fold.
    let parts = answer(text);
    for (
      let head = Math.floor(text.length / 2);
      !this.messageFitsInline('tool_result', parts, model);
      head = Math.floor(head / 2)
    ) {
      if (head === 0) throw new Error('Team tool answer cannot be recorded.');
      parts = answer(
        text.slice(0, head) +
          '\n… (truncated to fit the Session record; narrow task_list with its filters)',
      );
    }
    await this.commit('tool_result', parts, model);
    return parts;
  }

  /**
   * H4e-b3 decision 4 and 6 (b3c's decision 8): one member board
   * command's argument check, and the batch rule — a command call shares
   * its batch only with other command calls and with `send_message`
   * (whose member-addressed form is one, while to `"parent"` stays the
   * journal-only plain lane), since a command parks the Turn while the
   * leader answers.
   */
  private commandArgumentError(
    call: ToolCallRequestInfo,
    batch: readonly ToolCallRequestInfo[],
  ): string | undefined {
    const keys: Record<string, readonly string[]> = {
      exit_plan_mode: ['plan'],
      task_list: ['status', 'owner', 'blockedBy'],
      task_create: ['subject', 'description', 'activeForm', 'metadata'],
      task_update: [
        'taskId',
        'status',
        'owner',
        'subject',
        'description',
        'activeForm',
        'metadata',
        'addBlocks',
        'addBlockedBy',
      ],
    };
    const unsupported = Object.keys(call.args).find(
      (key) => !keys[call.name]?.includes(key),
    );
    if (unsupported !== undefined)
      return `Hosted ${call.name} received unsupported argument ${JSON.stringify(unsupported)}.`;
    if (
      batch.some(
        (other) =>
          other !== call &&
          !this.commandToolNames.has(other.name) &&
          other.name !== 'send_message',
      )
    )
      return `Hosted ${call.name} cannot share a batch with Workspace or Runtime calls; a command parks the Turn while the leader answers, so run board commands in their own batch or beside send_message.`;
    if (
      call.name === 'exit_plan_mode' &&
      (typeof call.args['plan'] !== 'string' || !call.args['plan'].trim())
    )
      return 'Hosted exit_plan_mode requires a nonempty plan.';
    if (call.name === 'task_create') {
      if (
        typeof call.args['subject'] !== 'string' ||
        !(call.args['subject'] as string).trim()
      )
        return 'Hosted task_create requires a nonempty subject.';
      if (
        typeof call.args['description'] !== 'string' ||
        !(call.args['description'] as string).trim()
      )
        return 'Hosted task_create requires a nonempty description.';
    }
    if (
      call.name === 'task_update' &&
      (typeof call.args['taskId'] !== 'string' ||
        !(call.args['taskId'] as string).trim())
    )
      return 'Hosted task_update requires the taskId of the task to update.';
    if (
      call.args['status'] !== undefined &&
      !TASK_STATUSES.includes(call.args['status'] as string)
    )
      return `Hosted ${call.name} status must be one of ${TASK_STATUSES.join(', ')}.`;
    return undefined;
  }

  /**
   * H4e-b3 decision 4: one member board command. Before the batch's first
   * command call runs, the Turn commits the `await_command` checkpoint
   * naming every command call of the batch; each call then commits its
   * outbound entry and polls its own journal for the reply, as
   * `await_agent` does for a child's acceptance, never holding the funnel
   * chain the relay's `handover` and `answered` commit on. The wait ends
   * at the reply, at 2 minutes from the entry's own commit, or with the
   * Turn; once one call of the Turn timed out, every later command call
   * of it refuses at once.
   */
  /** Decision 4's lock is the Turn's durable state, not just Turn
   * memory: every checkpoint of the Turn carries it, so a replacement
   * owner re-arms from whichever one it resumes, and a timed-out leader
   * stays unanswering for every later command, across restarts as across
   * seconds. */
  private async syncCommandTimedOutFromDurable(): Promise<void> {
    if (this.commandTimedOut) return;
    const authorization =
      await this.session.authority.harnessRunAuthorization();
    if (
      authorization.status === 'runnable' &&
      harnessCommandLocked(authorization.checkpoint, this.promptId)
    )
      this.commandTimedOut = true;
  }

  private async acceptSessionCommand(
    request: { call: ToolCallRequestInfo },
    model: string,
    signal: AbortSignal,
    batchRuns: readonly HarnessCommandWaitRun[],
  ): Promise<Part[]> {
    const { name, callId, args } = request.call;
    const commands = this.commands;
    if (commands === undefined)
      throw new Error('A member command call has no command funnel.');
    await this.syncCommandTimedOutFromDurable();
    const kind: SessionCommandKind =
      name === 'task_list'
        ? 'board_read'
        : name === 'send_message'
          ? 'member_message'
          : name === 'exit_plan_mode'
            ? 'plan_submit'
            : 'board_write';
    const key = this.session.authority.sessionHeader.sessionKey;
    const commandId = sessionCommandId({
      senderSessionId: key.sessionId,
      promptKey: hostedPromptKey(this.promptId),
      callId,
    });
    // Before this batch's first command call runs, the park names every
    // command call of the batch. Batch siblings replay the same run set;
    // a fully folded earlier batch left no durable wait, and a later
    // batch of this Turn parks afresh under its own run set.
    const parkKey = batchRuns.map((run) => run.commandId).join(':');
    if (!this.commandParks.has(parkKey)) {
      const argsRef = await this.session.resources.publish(
        'managed-command-args',
        Buffer.from(JSON.stringify(args), 'utf8'),
      );
      await this.harness.commitAwaitCommand(
        batchRuns,
        { turnId: this.promptId, promptId: this.promptId },
        {
          holdsWorkspaceMount: this.acquired,
          attempt: {
            attemptId: batchRuns[0]?.modelMessageId ?? this.promptId,
            routeRef: argsRef,
          },
        },
      );
      this.commandParks.add(parkKey);
    }
    const answer = async (text: string, failed: boolean): Promise<Part[]> => {
      const parts = failed
        ? convertToFunctionErrorResponse(name, callId, [], text)
        : convertToFunctionResponse(name, callId, [{ text }]);
      await this.commit('tool_result', parts, model);
      return parts;
    };
    if (this.commandTimedOut) {
      // The lock refuses only a call that sent nothing. A call whose
      // outbound already exists is the one whose own wait timed out,
      // named again by a re-driven batch: its journal answers it.
      const parts =
        commands.command(commandId) === undefined
          ? await answer(SESSION_COMMAND_LEADER_UNANSWERING_TEXT, true)
          : await this.answerCommandByJournal(
              commands,
              request,
              commandId,
              model,
            );
      // The locked run still folds, or the Turn's wait never completes —
      // its answer rides the batch the same as a call that ran.
      await this.harness.resolveAwaitCommand(commandId, { timedOut: true });
      return parts;
    }
    if (signal.aborted) {
      return answer('The turn was cancelled before this tool call ran.', true);
    }
    try {
      await commands.runCommand({
        commandId,
        kind,
        args: { ...args },
        executionCallId: this.childRunIdFor(callId),
        closing: this.session.authority.currentActivation?.phase !== 'active',
      });
    } catch (cause) {
      // byte_limit and budget_exhausted are the funnel's member-facing
      // refusals; a store fault is recovery's, never the call's answer.
      if (cause instanceof ManagedSessionRecordError) {
        const parts = await answer(cause.message, true);
        // A normal local refusal still owes the parked wait its fold —
        // a durable wait it leaves behind turns the Turn's next call
        // into a recovery fault.
        await this.harness.resolveAwaitCommand(commandId);
        return parts;
      }
      throw cause;
    }
    // The bound measures from the entry's own commit, so a resumed wait
    // keeps what is left instead of a fresh 2 minutes.
    const anchor = commands.outboundCommittedAt(commandId) ?? Date.now();
    const deadline = anchor + COMMAND_WAIT_MS;
    for (;;) {
      if (signal.aborted) {
        const parts = await this.answerCommandByJournal(
          commands,
          request,
          commandId,
          model,
        );
        await this.harness.resolveAwaitCommand(commandId);
        return parts;
      }
      const record = commands.command(commandId);
      const state = record?.run.delivery?.state;
      if (state === 'accepted' || state === 'consumed') {
        const reply = await commands.readReply(commandId);
        if (reply !== null) {
          const parts = await this.commitCommandReply(
            request,
            reply.text,
            reply.outcome === 'refused',
            model,
          );
          await commands.commitConsumed(commandId);
          await this.harness.resolveAwaitCommand(commandId);
          return parts;
        }
      }
      if (
        state === 'rejected' ||
        state === 'cancelled' ||
        state === 'unknown'
      ) {
        const parts = await this.answerCommandByJournal(
          commands,
          request,
          commandId,
          model,
        );
        await this.harness.resolveAwaitCommand(commandId);
        return parts;
      }
      if (Date.now() >= deadline) {
        this.commandTimedOut = true;
        // The lock is stamped at detection time — before this Turn's next
        // commit, so a crash in the settle/tool_result window between the
        // accepting-to-unknown write and its answer can never un-lock it.
        await this.harness.markCommandWaitTimeout();
        const parts = await this.answerCommandByJournal(
          commands,
          request,
          commandId,
          model,
        );
        // The fold restates the Turn's lock: a replacement owner of this
        // Turn re-arms from it and refuses the next command too.
        await this.harness.resolveAwaitCommand(commandId, {
          timedOut: true,
        });
        return parts;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Decision 14: the command call's answer by what its journal committed.
   * A planned entry is cancelled and answered as not sent; a handed-over
   * one says the command reached the leader and a write may have taken
   * effect; rejected, cancelled and unknown are said so, with a reply
   * that landed mid-race still read. The settle's conflict is the race's
   * own evidence, so once it loses the journal is re-read and answered.
   */
  private async answerCommandByJournal(
    commands: HostedSessionCommandSession,
    request: { call: Pick<ToolCallRequestInfo, 'name' | 'callId'> },
    commandId: string,
    model: string,
    journaled?: ReadonlySet<string>,
  ): Promise<Part[]> {
    const { name, callId } = request.call;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const record = commands.command(commandId);
      if (record === undefined) {
        // 未发送：没有记录要结算，直接给了计划态的答案，不再走
        // settle（那只会抛 "has no record to revise"）。
        const unsent = convertToFunctionErrorResponse(
          name,
          callId,
          [],
          sessionCommandEvidenceText('planned'),
        );
        if (!journaled?.has(callId))
          await this.commit('tool_result', unsent, model);
        return unsent;
      }
      const state = record.run.delivery?.state;
      if (state === 'accepted' || state === 'consumed') {
        const reply = await commands.readReply(commandId);
        if (reply !== null) {
          const parts = await this.commitCommandReply(
            request,
            reply.text,
            reply.outcome === 'refused',
            model,
            journaled,
          );
          // A call consumes only the reply it commits now: one already
          // answered may have read the not-sent or unknown evidence before
          // the relay's reply landed, and never read this one.
          if (!journaled?.has(callId)) await commands.commitConsumed(commandId);
          return parts;
        }
        continue;
      }
      try {
        if (state === 'planned') await commands.settle(commandId, 'cancelled');
        if (state === 'accepting') await commands.settle(commandId, 'unknown');
      } catch (cause) {
        if (cause instanceof ManagedSessionConflictError) continue;
        throw cause;
      }
      const parts = convertToFunctionErrorResponse(
        name,
        callId,
        [],
        sessionCommandEvidenceText(
          // The accepted/consumed arm above returned already; what remains
          // of the delivery vocabulary is exactly the settle-relevant five.
          state as
            | 'planned'
            | 'accepting'
            | 'rejected'
            | 'cancelled'
            | 'unknown',
        ),
      );
      if (!journaled?.has(callId))
        await this.commit('tool_result', parts, model);
      return parts;
    }
    throw new Error(`Session command ${commandId} never settled.`);
  }

  /** A long board answer folds to the inline bound, as the team tools'. */
  private async commitCommandReply(
    request: { call: Pick<ToolCallRequestInfo, 'name' | 'callId'> },
    text: string,
    failed: boolean,
    model: string,
    journaled?: ReadonlySet<string>,
  ): Promise<Part[]> {
    const { name, callId } = request.call;
    const make = (each: string): Part[] =>
      failed
        ? convertToFunctionErrorResponse(name, callId, [], each)
        : convertToFunctionResponse(name, callId, [{ text: each }]);
    let parts = make(text);
    for (
      let head = Math.floor(text.length / 2);
      !this.messageFitsInline('tool_result', parts, model);
      head = Math.floor(head / 2)
    ) {
      if (head === 0) throw new Error('Command answer cannot be recorded.');
      parts = make(
        text.slice(0, head) +
          '\n… (truncated to fit the Session record; narrow task_list with its filters)',
      );
    }
    if (!journaled?.has(callId)) await this.commit('tool_result', parts, model);
    return parts;
  }

  /**
   * The recovered arm of the command wait (decision 4): re-enter the poll
   * the dead owner's acceptSessionCommand ran, for every run the
   * checkpoint still owes, with what is left of the bound measured from
   * the entry's own commit. A restart lost the Turn's in-memory mount,
   * so the lease the checkpoint's flag names comes back first, and the
   * journaled set keeps a replayed fold silent — the resolve still runs
   * so the wait advances. A call already answered never consumes: what
   * it read is the journaled answer, which may predate the reply.
   */
  async resumeCommandWaitRuns(
    runs: readonly HarnessCommandWaitRun[],
    holdsWorkspaceMount: boolean,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const commands = this.commands;
    if (commands === undefined)
      throw new Error('Recovered command wait has no command funnel.');
    if (holdsWorkspaceMount && !this.acquired) {
      await this.acquire(false, signal);
    }
    const journaled = await journaledToolResultIds(this.session, this.promptId);
    await this.syncCommandTimedOutFromDurable();
    for (const run of runs) {
      if (run.folded) continue;
      const request = {
        call: { name: run.toolName, callId: run.functionCallId },
      };
      const anchor = commands.outboundCommittedAt(run.commandId) ?? Date.now();
      const deadline = anchor + COMMAND_WAIT_MS;
      for (;;) {
        const record = commands.command(run.commandId);
        if (this.commandTimedOut) {
          if (record === undefined) {
            // A call the lock refused before it sent anything: the same
            // fixed answer the live arm gives every later call.
            const locked = convertToFunctionErrorResponse(
              run.toolName,
              run.functionCallId,
              [],
              SESSION_COMMAND_LEADER_UNANSWERING_TEXT,
            );
            if (!journaled.has(run.functionCallId))
              await this.commit('tool_result', locked, model);
          } else if (!journaled.has(run.functionCallId)) {
            // The call whose own wait timed out: the dead owner stamped
            // the lock at detection and may have died before settling
            // it. Its journal answers it — a planned entry cancelled as
            // not sent, a handed-over one unknown — never the later
            // calls' refusal, or the entry stays live for the relay to
            // deliver after the wait has ended. A call already answered
            // was settled first (the timeout arm settles, then answers),
            // so a reply the relay copied in since is not what it read
            // and is never consumed: it only folds.
            await this.answerCommandByJournal(
              commands,
              request,
              run.commandId,
              model,
              journaled,
            );
          }
          await this.harness.resolveAwaitCommand(run.commandId, {
            timedOut: true,
          });
          break;
        }
        if (record === undefined) {
          // The checkpoint names a call whose outbound was never
          // committed — the dead owner exited between the two steps,
          // and no process will ever commit it now. This answer holds
          // under any signal: a cancelled recovery must not fall into
          // arm that would try (and fail) to settle a record that does
          // not exist.
          const unsent = convertToFunctionErrorResponse(
            run.toolName,
            run.functionCallId,
            [],
            sessionCommandEvidenceText('planned'),
          );
          if (!journaled.has(run.functionCallId))
            await this.commit('tool_result', unsent, model);
          await this.harness.resolveAwaitCommand(run.commandId);
          break;
        }
        if (signal.aborted) {
          await this.answerCommandByJournal(
            commands,
            request,
            run.commandId,
            model,
            journaled,
          );
          await this.harness.resolveAwaitCommand(run.commandId);
          break;
        }
        const state = record.run.delivery?.state;
        if (state === 'accepted' || state === 'consumed') {
          const reply = await commands.readReply(run.commandId);
          if (reply !== null) {
            await this.commitCommandReply(
              request,
              reply.text,
              reply.outcome === 'refused',
              model,
              journaled,
            );
            // The same rule as the journal arm: only the reply committed
            // now is the one the call read.
            if (!journaled.has(run.functionCallId))
              await commands.commitConsumed(run.commandId);
            await this.harness.resolveAwaitCommand(run.commandId);
            break;
          }
        }
        if (
          state === 'rejected' ||
          state === 'cancelled' ||
          state === 'unknown'
        ) {
          await this.answerCommandByJournal(
            commands,
            request,
            run.commandId,
            model,
            journaled,
          );
          await this.harness.resolveAwaitCommand(run.commandId);
          break;
        }
        if (Date.now() >= deadline) {
          this.commandTimedOut = true;
          // The lock is stamped at detection time — before the journal
          // arm's next commit, so a crash between the settle and the
          // tool_result write can never un-lock it.
          await this.harness.markCommandWaitTimeout();
          await this.answerCommandByJournal(
            commands,
            request,
            run.commandId,
            model,
            journaled,
          );
          await this.harness.resolveAwaitCommand(run.commandId, {
            timedOut: true,
          });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  /**
   * The foreground arm: the call's answer always re-derives from the
   * committed chain — a crashed Session resumes into this same wait and
   * answers from the settled run and its acceptance, never from relay
   * memory. A failed or cancelled child is read and told, never revived.
   */
  private async awaitChildToolResult(
    children: HostedChildAgentSession,
    request: { call: Pick<ToolCallRequestInfo, 'name' | 'callId'> },
    childRunId: string,
    model: string,
    signal: AbortSignal,
    journaled?: ReadonlySet<string>,
  ): Promise<Part[]> {
    for (;;) {
      if (signal.aborted) {
        const abandoned = convertToFunctionErrorResponse(
          request.call.name,
          request.call.callId,
          [],
          HOSTED_AGENT_WAIT_ABANDONED_TEXT,
        );
        if (!journaled?.has(request.call.callId))
          await this.commit('tool_result', abandoned, model);
        await this.harness.resolveAwaitAgent(childRunId);
        return abandoned;
      }
      const record = children.record(childRunId);
      if (record !== undefined) {
        if (record.run.state === 'failed' || record.run.state === 'cancelled') {
          const ended = convertToFunctionErrorResponse(
            request.call.name,
            request.call.callId,
            [],
            childRunEndedText(record),
          );
          if (!journaled?.has(request.call.callId))
            await this.commit('tool_result', ended, model);
          await this.harness.resolveAwaitAgent(childRunId);
          return ended;
        }
        const acceptance = children.acceptance(childRunId);
        if (acceptance !== undefined) {
          const text = (
            await this.session.resources.read(acceptance.contentRef)
          ).toString('utf8');
          // The answer still must land: fold the accepted result down
          // to the inline bound with its marker instead of parking the
          // parent — the full bytes stay on the acceptance record. The
          // fit predicate measures exactly the record this commit writes.
          // #13753 I2: a worktree child's merge outcome follows the result
          // and survives the fold, which cuts only the result.
          const fitted = fitChildResultInline(
            request.call.name,
            request.call.callId,
            text,
            (parts) => this.messageFitsInline('tool_result', parts, model),
            await childWorkspaceAnswerSuffix(
              record.kind === 'child_agent' ? record : undefined,
              acceptance,
              (ref) => this.session.resources.read(ref),
            ),
          );
          if (!journaled?.has(request.call.callId))
            await this.commit('tool_result', fitted, model);
          await children.markAccepted(childRunId);
          this.childConsumption(childRunId);
          await this.harness.resolveAwaitAgent(childRunId);
          return fitted;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Starts the observation loop for a watch fresh out of its v3 start,
   * once per Session lifetime: the loop resumes an already-attached
   * record and is fed lines through the Session publisher's fan-out.
   */
  private async resumeMonitorWatch(
    executionCallId: string,
    runtimeCallId: string,
  ): Promise<void> {
    // The lane is Shell-mode or the publication lane, whichever this turn
    // owns — the detached family's loops park on it either way.
    const lane = this.shell ?? this.backgroundLane;
    if (!lane || !this.publisher || !this.monitors) return;
    const loops = (lane.monitorLoops ??= new Map());
    if (loops.has(executionCallId)) return;
    const record = this.monitors.record(executionCallId);
    if (!record) return;
    const argsBody = JSON.parse(
      (await this.session.resources.read(record.commandRef)).toString('utf8'),
    ) as Record<string, unknown>;
    // The watch runs on this turn's Runtime Session; its auto-stop asks
    // the worker there, and that Session outlives the turn as a hold.
    const executor = new HostedMonitorRemoteExecutor(this.publisher, {
      broker: this.broker,
      sessionKey: this.session.authority.sessionHeader.sessionKey,
      executionCallId,
      runtimeCallId,
    });
    const loop = new HostedMonitorLoop(
      this.monitors,
      executionCallId,
      executor,
      undefined,
      () => lane.monitorWakeKick?.(),
    );
    // Register the loop only after its start went through: a failed resume
    // leaves no dead entry to short-circuit every later one (the fan-out
    // rides the remote executor, not this map, so line order is unaffected).
    await loop.resumeAttached({
      ownerScopeId: this.session.authority.sessionHeader.sessionKey.sessionId,
      executionCallId,
      args: argsBody,
      maxEvents: record.maxEvents,
      idleTimeoutMs: record.idleTimeoutMs,
      debounceMs: record.debounceMs,
      runtime: record.run.runtime!,
    });
    loops.set(executionCallId, loop);
  }

  /**
   * H3 background Shell settlement. A proven unstarted refuse rides the
   * unstarted family as-is (settled as start_failed on the record); a
   * settled detached handle lands as the third durable receipt family —
   * blocked delivery, null resultRef, resolve — with the physical start
   * attached to the record from the same facts before history is written.
   */
  private async acceptBackgroundShell(
    request: {
      call: ToolCallRequestInfo;
      input: Record<string, unknown>;
    },
    executionCallId: string,
    saved: {
      publicationId: string;
      publicationToken: string;
      runtimeBindingId: string;
      bindingGeneration: string;
      runtimeCallId: string;
    },
    result: ToolResultEnvelope,
    model: string,
  ): Promise<Part[]> {
    if (result.executionStatus === 'not_started' && result.capture === null) {
      // Prove before settle: the owner's close gate is the authority on
      // "this start never happened". Settling the record first and then
      // seeing the proof refused would freeze a run that actually started
      // into a line no later fact may ever touch.
      const parts = await this.acceptShell(
        request.call,
        executionCallId,
        saved.publicationId,
        saved.publicationToken,
        result,
        model,
      );
      await this.childRuns!.settleFailed(executionCallId, {
        stopReason: 'start_failed',
        started: false,
      });
      return parts;
    }
    if (
      result.executionStatus !== 'success' ||
      result.capture?.captureStatus !== 'detached'
    ) {
      throw new Error(
        `Background Shell settled with an unexpected result shape (${result.executionStatus}).`,
      );
    }
    const authority = this.session.authority;
    let receipt = authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'tool.receipt' &&
          event.payload['executionCallId'] === executionCallId,
      );
    if (receipt === undefined) {
      // Attach the physical start to the record before history is written —
      // replay-tolerant: a retry after a crash between attach and journal
      // finds its own start receipt on this identity and must not mint a
      // rerun; any mismatched receipt stays the funnel's rerun refusal.
      const existing = this.childRuns!.record(executionCallId);
      if (existing === undefined || existing.startReceiptRef === null) {
        await this.childRuns!.attach(
          executionCallId,
          {
            runtimeBindingId: saved.runtimeBindingId,
            generation: saved.bindingGeneration,
          },
          {
            executionCallId,
            runtimeCallId: saved.runtimeCallId,
            unitName: `qwen-bg-${saved.runtimeCallId.replace(/[^a-zA-Z0-9._-]/g, '-')}`,
            bindingGeneration: saved.bindingGeneration,
            occurredAt: Date.now(),
          },
        );
      }
      // A Shell that ended before this attach left its finalize refused:
      // with the start receipt now committed, the settle completes here.
      await this.publisher?.settleAttached(executionCallId);
    }
    let ref: ManagedSessionDurableRef;
    let converted: Part[];
    let messageId: string;
    let timestamp: string;
    if (receipt) {
      ref = assertManagedSessionDurableRef(
        receipt.payload['toolOutcomeRef'],
        'original tool outcome',
      );
      const savedResult = JSON.parse(
        (await this.session.resources.read(ref)).toString('utf8'),
      ) as Record<string, unknown>;
      const history = savedResult['history'] as
        | Record<string, unknown>
        | undefined;
      if (
        savedResult['schemaVersion'] !== 1 ||
        savedResult['decision'] !== 'blocked' ||
        !isDeepStrictEqual(savedResult['envelope'], result) ||
        savedResult['manifestRef'] !== null ||
        receipt.payload['resultRef'] !== null ||
        (receipt.payload['resources'] !== undefined &&
          !isDeepStrictEqual(receipt.payload['resources'], [])) ||
        receipt.payload['historyRevision'] !== receipt.sequence ||
        typeof history?.['messageId'] !== 'string' ||
        typeof history['timestamp'] !== 'string' ||
        typeof history['model'] !== 'string' ||
        !Array.isArray(history['parts'])
      )
        throw new Error('Original background Shell receipt conflicts.');
      converted = history['parts'] as Part[];
      messageId = history['messageId'] as string;
      timestamp = history['timestamp'] as string;
      model = history['model'] as string;
    } else {
      converted = convertToFunctionResponse(
        request.call.name,
        request.call.callId,
        result.responseParts as Part[],
      );
      const response = converted[0]?.functionResponse;
      if (!response || converted.length !== 1)
        throw new Error('Background Shell result cannot be recorded.');
      response.response = {
        ...response.response,
        executionStatus: 'success',
      };
      if (!this.messageFitsInline('tool_result', converted, model))
        throw new Error('Background Shell result cannot be recorded.');
      const originalIntent = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.intent' &&
            event.payload['executionCallId'] === executionCallId,
        );
      if (!originalIntent)
        throw new Error('Original background Shell intent is missing.');
      messageId = shellHistoryId(executionCallId);
      timestamp = new Date(originalIntent.occurredAt).toISOString();
      const outcome = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          decision: 'blocked',
          envelope: result,
          manifestRef: null,
          history: { messageId, timestamp, model, parts: converted },
        }),
      );
      if (
        outcome.byteLength >
        HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
      )
        throw new Error('Background Shell outcome exceeds its limit.');
      ref = await this.session.resources.publish(
        'managed-tool-outcome',
        outcome,
      );
      await authority.appendExecutionEvent(
        {
          operation: 'recordToolResult',
          commandId: executionCallId,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: ref.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `tool-receipt:${executionCallId}`,
          sessionKey: authority.sessionHeader.sessionKey,
          kind: 'tool.receipt',
          occurredAt: Date.now(),
          payload: {
            executionCallId,
            toolOutcomeRef: ref,
            resultRef: null,
            resources: [],
            historyRevision: sequence,
          },
        }),
        { class: 'trusted_entry' },
      );
      receipt = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.receipt' &&
            event.payload['executionCallId'] === executionCallId,
        );
    }
    if (!receipt)
      throw new Error('Original background Shell receipt disappeared.');
    await this.commit('tool_result', converted, model, {
      uuid: messageId,
      timestamp,
    });
    await this.harness.resolveAwaitRuntime(executionCallId, ref);
    try {
      await this.broker.acknowledgeV3(executionCallId, {
        executionCallId,
        manifest: null,
        deliveryStatus: 'blocked',
        historyRevision: null,
      });
    } catch (cause) {
      writeStderrLineSafe(
        'qwen serve: Background Shell v3 ACK can be retried after its Session receipt: ' +
          String(cause),
      );
    }
    return converted;
  }

  private async acceptShell(
    call: ToolCallRequestInfo,
    executionCallId: string,
    publicationId: string,
    publicationToken: string,
    brokerResult: ToolResultEnvelope,
    model: string,
  ): Promise<Part[]> {
    if (
      brokerResult.executionStatus === 'not_started' &&
      brokerResult.capture === null
    ) {
      const owner = this.publication!.owner;
      const closed = (await owner.request(
        '/grants',
        {
          publication: 'managed-tool-publication/1',
          operation: 'close_not_started',
          sessionKey: this.session.authority.sessionHeader.sessionKey,
          owner: await owner.owner(),
          publicationId,
        },
        publicationToken,
      )) as Record<string, unknown>;
      if (closed['state'] !== 'NOT_STARTED')
        throw new Error('Original Shell was not proven unstarted.');
      const authority = this.session.authority;
      let receipt = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.receipt' &&
            event.payload['executionCallId'] === executionCallId,
        );
      let ref: ManagedSessionDurableRef;
      let converted: Part[];
      let messageId: string;
      let timestamp: string;
      if (receipt) {
        ref = assertManagedSessionDurableRef(
          receipt.payload['toolOutcomeRef'],
          'original tool outcome',
        );
        const saved = JSON.parse(
          (await this.session.resources.read(ref)).toString('utf8'),
        ) as Record<string, unknown>;
        const history = saved['history'] as Record<string, unknown> | undefined;
        if (
          saved['schemaVersion'] !== 1 ||
          saved['decision'] !== 'blocked' ||
          !isDeepStrictEqual(saved['envelope'], brokerResult) ||
          saved['manifestRef'] !== null ||
          receipt.payload['resultRef'] !== null ||
          receipt.payload['historyRevision'] !== receipt.sequence ||
          typeof history?.['messageId'] !== 'string' ||
          typeof history['timestamp'] !== 'string' ||
          typeof history['model'] !== 'string' ||
          !Array.isArray(history['parts'])
        )
          throw new Error('Original unstarted Shell receipt conflicts.');
        converted = history['parts'] as Part[];
        messageId = history['messageId'];
        timestamp = history['timestamp'];
        model = history['model'];
      } else {
        const errorMessage = brokerResult.error?.message;
        const modelMessage =
          errorMessage && errorMessage.length > 4096
            ? `${errorMessage.slice(0, 2048)}\n[... error truncated ...]\n${errorMessage.slice(-2048)}`
            : (errorMessage ?? 'Runtime Shell did not start.');
        converted = convertToFunctionErrorResponse(
          call.name,
          call.callId,
          [],
          modelMessage,
        );
        const response = converted[0]?.functionResponse;
        if (!response || converted.length !== 1)
          throw new Error('Unstarted Shell result cannot be recorded.');
        response.response = {
          ...response.response,
          executionStatus: 'not_started',
        };
        if (!this.messageFitsInline('tool_result', converted, model))
          throw new Error('Unstarted Shell result cannot be recorded.');
        const originalIntent = authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .find(
            (event) =>
              event.kind === 'tool.intent' &&
              event.payload['executionCallId'] === executionCallId,
          );
        if (!originalIntent)
          throw new Error('Original Shell intent is missing.');
        messageId = shellHistoryId(executionCallId);
        timestamp = new Date(originalIntent.occurredAt).toISOString();
        const outcome = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            decision: 'blocked',
            envelope: brokerResult,
            manifestRef: null,
            history: { messageId, timestamp, model, parts: converted },
          }),
        );
        if (
          outcome.length >
          HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
        )
          throw new Error('Unstarted Shell outcome exceeds its limit.');
        ref = await this.session.resources.publish(
          'managed-tool-outcome',
          outcome,
        );
        await authority.appendExecutionEvent(
          {
            operation: 'recordToolResult',
            commandId: executionCallId,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: ref.digest,
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: `tool-receipt:${executionCallId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            kind: 'tool.receipt',
            occurredAt: Date.now(),
            payload: {
              executionCallId,
              toolOutcomeRef: ref,
              resultRef: null,
              resources: [],
              historyRevision: sequence,
            },
          }),
          { class: 'trusted_entry' },
        );
        receipt = authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .find(
            (event) =>
              event.kind === 'tool.receipt' &&
              event.payload['executionCallId'] === executionCallId,
          );
      }
      if (!receipt)
        throw new Error('Original unstarted Shell receipt disappeared.');
      await this.commit('tool_result', converted, model, {
        uuid: messageId,
        timestamp,
      });
      await this.harness.resolveAwaitRuntime(executionCallId, ref);
      return converted;
    }
    const owner = this.publication!.owner;
    const finished = await owner.request(
      `/publications/${publicationId}/finished`,
      {},
    );
    const source = finished as Record<string, unknown>;
    const envelope = parseToolResultEnvelope(source['result']);
    if (!isDeepStrictEqual(envelope, parseToolResultEnvelope(brokerResult)))
      throw new Error('Broker result differs from the finished publication.');
    const manifestRef = envelope.capture?.manifest ?? null;
    const decision =
      envelope.capture?.captureStatus === 'complete' ? 'committed' : 'blocked';
    const authority = this.session.authority;
    let receipt = authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'tool.receipt' &&
          event.payload['executionCallId'] === executionCallId,
      );
    let ref!: ManagedSessionDurableRef;
    let converted: Part[];
    let messageId: string;
    let timestamp: string;
    if (receipt) {
      ref = assertManagedSessionDurableRef(
        receipt.payload['toolOutcomeRef'],
        'original tool outcome',
      );
      const saved = JSON.parse(
        (await this.session.resources.read(ref)).toString('utf8'),
      ) as Record<string, unknown>;
      const history = saved['history'] as Record<string, unknown> | undefined;
      if (
        saved['schemaVersion'] !== 1 ||
        saved['decision'] !== decision ||
        !isDeepStrictEqual(saved['envelope'], envelope) ||
        !isDeepStrictEqual(saved['manifestRef'], manifestRef) ||
        !isDeepStrictEqual(
          receipt.payload['resultRef'],
          decision === 'committed' ? manifestRef : null,
        ) ||
        typeof history?.['messageId'] !== 'string' ||
        typeof history['timestamp'] !== 'string' ||
        typeof history['model'] !== 'string' ||
        !Array.isArray(history['parts'])
      )
        throw new Error('Original Shell receipt conflicts with its result.');
      converted = history['parts'] as Part[];
      model = history['model'];
      messageId = history['messageId'];
      timestamp = history['timestamp'];
    } else {
      const responseParts = boundedShellPreview(
        envelope.responseParts,
      ) as Part[];
      converted =
        envelope.executionStatus === 'success'
          ? convertToFunctionResponse(call.name, call.callId, responseParts)
          : convertToFunctionErrorResponse(
              call.name,
              call.callId,
              responseParts,
              envelope.error?.message ??
                `Runtime tool ${envelope.executionStatus}.`,
            );
      if (converted.length === 1 && converted[0]?.functionResponse) {
        const response = converted[0].functionResponse;
        response.response = {
          ...response.response,
          executionStatus: envelope.executionStatus,
          manifestRef,
          captureStatus: envelope.capture?.captureStatus ?? 'unavailable',
          previewTruncated: envelope.capture?.previewTruncated ?? false,
        };
      }
      if (
        converted.length !== 1 ||
        !converted[0]?.functionResponse ||
        !this.messageFitsInline('tool_result', converted, model)
      ) {
        converted = [
          {
            functionResponse: {
              id: call.callId,
              name: call.name,
              response: {
                executionStatus: envelope.executionStatus,
                captureStatus: envelope.capture?.captureStatus ?? 'unavailable',
                manifestRef,
                previewTruncated: envelope.capture?.previewTruncated ?? false,
                outputOmitted: true,
                summary: 'The Shell result was saved in its immutable capture.',
              },
            },
          },
        ];
      }
      if (!this.messageFitsInline('tool_result', converted, model))
        throw new Error('Original Shell history exceeds the Session limit.');
      const originalIntent = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.intent' &&
            event.payload['executionCallId'] === executionCallId,
        );
      if (!originalIntent) throw new Error('Original Shell intent is missing.');
      messageId = shellHistoryId(executionCallId);
      timestamp = new Date(originalIntent.occurredAt).toISOString();
      const outcome = {
        schemaVersion: 1,
        decision,
        envelope,
        manifestRef,
        history: { messageId, timestamp, model, parts: converted },
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          ref = (await owner.request(
            `/publications/${publicationId}/admissions/prepare`,
            outcome,
          )) as unknown as ManagedSessionDurableRef;
          break;
        } catch (error) {
          const uncertain =
            (error instanceof ManagedSessionStoreHttpError &&
              (error.status === 429 || error.status >= 500)) ||
            error instanceof TypeError ||
            (error instanceof DOMException &&
              ['AbortError', 'TimeoutError'].includes(error.name));
          if (!uncertain || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      owner.rememberAdmission(publicationId, ref);
      await authority.appendExecutionEvent(
        {
          operation: 'recordToolResult',
          commandId: executionCallId,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: ref.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `tool-receipt:${executionCallId}`,
          sessionKey: authority.sessionHeader.sessionKey,
          kind: 'tool.receipt',
          occurredAt: Date.now(),
          payload: {
            executionCallId,
            toolOutcomeRef: ref,
            resultRef: decision === 'committed' ? manifestRef : null,
            resources: manifestRef ? [manifestRef] : [],
            historyRevision: sequence,
          },
        }),
        { class: 'trusted_entry' },
      );
      receipt = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.receipt' &&
            event.payload['executionCallId'] === executionCallId,
        );
    }
    if (!receipt) throw new Error('Original Shell receipt disappeared.');
    await this.commit('tool_result', converted, model, {
      uuid: messageId,
      timestamp,
    });
    if (decision === 'committed')
      await this.harness.resolveAwaitRuntime(executionCallId, ref);
    try {
      await this.broker.acknowledgeV3(executionCallId, {
        executionCallId,
        manifest: manifestRef,
        deliveryStatus: decision,
        historyRevision: decision === 'committed' ? receipt.sequence : null,
      });
    } catch (cause) {
      writeStderrLineSafe(
        'qwen serve: Tool v3 ACK can be retried after its Session receipt: ' +
          String(cause),
      );
    }
    if (decision !== 'committed')
      throw new Error('Incomplete Shell capture blocked the Hosted tool turn.');
    return converted;
  }

  /**
   * Asks before each call that the approval mode does not pre-approve, one at
   * a time in the model's order, and returns the refusal for each call that
   * will not run. Nothing runs once the turn is cancelled.
   */
  private async approve(
    requests: ReadonlyArray<{ call: ToolCallRequestInfo; inputBytes: Buffer }>,
    messageId: string,
    inputRefs: Map<number, ManagedSessionDurableRef>,
    signal: AbortSignal,
    nextOrdinal = 0,
  ): Promise<Array<string | undefined>> {
    const refusals: Array<string | undefined> =
      this.nativeBatch?.refusals ??
      requests.map((request) =>
        this.hookPermission.get(request.call.callId) === 'deny'
          ? 'PermissionRequest Hook denied the call.'
          : undefined,
      );
    if (this.nativeBatch) this.nativeBatch.refusals = refusals;
    const approval = this.approval;
    if (!approval) return refusals;
    const searchProfile = this.searchProfile;
    let asked = false;
    for (const [index, request] of requests.entries()) {
      if (index < nextOrdinal) continue;
      if (
        refusals[index] ||
        (request.call.name === 'skill' && this.skills !== undefined) ||
        this.hookPermission.get(request.call.callId) === 'allow' ||
        !hostedApprovalAsks(approval.settings, request.call.name, searchProfile)
      )
        continue;
      asked = true;
      if (signal.aborted) break;
      if (this.unanswered) {
        refusals[index] = APPROVAL_REFUSALS.unanswered;
        continue;
      }
      const inputRef = await this.session.resources.publish(
        'managed-tool-input',
        request.inputBytes,
      );
      inputRefs.set(index, inputRef);
      refusals[index] = await this.ask(
        approval,
        request.call,
        inputRef,
        messageId,
        signal,
      );
    }
    return asked && signal.aborted
      ? refusals.map((reason) => reason ?? APPROVAL_REFUSALS.cancelled)
      : refusals;
  }

  private async ask(
    approval: HostedApprovalTurnOptions,
    call: ToolCallRequestInfo,
    inputRef: ManagedSessionDurableRef,
    messageId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const authority = this.session.authority;
    const requestId = `tool_approval_${randomBytes(16).toString('hex')}`;
    const createdAt = Date.now();
    const ordinal =
      this.nativeBatch?.requests.findIndex(
        (request) => request.call.callId === call.callId,
      ) ?? -1;
    if (ordinal >= 0) this.nativeBatch!.actionIds.set(ordinal, requestId);
    const continuationRef =
      ordinal < 0
        ? undefined
        : await this.captureNativeBatch('approval', requestId, ordinal);
    if (ordinal >= 0 && !continuationRef) this.nativeBatch!.uncaptured = true;
    const options: HostedActionOptions = {
      ...(continuationRef
        ? {
            v: 3 as const,
            continuationRef,
            ...(HOSTED_INPUT_PREVIEW_TOOLS.includes(call.name)
              ? { inputRef }
              : {}),
          }
        : HOSTED_INPUT_PREVIEW_TOOLS.includes(call.name)
          ? { v: 2 as const, inputRef }
          : { v: 1 as const }),
      requestId,
      turnId: this.promptId,
      functionCallId: call.callId,
      toolName: call.name,
      policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
      inputRevision: 1,
      createdAt,
      expiresAt: createdAt + approval.settings.timeoutMs,
      options: HOSTED_APPROVAL_OPTIONS,
    };
    const optionsRef = await this.session.resources.publish(
      'managed-action-options',
      Buffer.from(JSON.stringify(options)),
    );
    if (signal.aborted) return APPROVAL_REFUSALS.cancelled;
    await this.harness.commitDurableWait(
      {
        requestId,
        kind: 'permission',
        source: 'tool_call',
        optionsRef,
        inputRevision: '1',
        invocationRef: inputRef,
        attemptId: messageId,
        routeRef: inputRef,
      },
      { turnId: this.promptId, promptId: this.promptId },
    );
    await approval.waiters.wait(
      requestId,
      options.expiresAt,
      signal,
      () =>
        authority.action(requestId)?.state !== 'requested' ||
        authority.writesStopped,
    );
    if (authority.action(requestId)?.state === 'requested')
      await endHostedAction(
        this.session,
        requestId,
        signal.aborted ? 'cancelled' : 'expired',
      );
    await this.harness.resolveDurableWait();
    const action = authority.action(requestId)!;
    if (action.state === 'decided')
      return hostedActionAllowed(action, options.policyRevision)
        ? undefined
        : APPROVAL_REFUSALS.denied;
    if (action.state !== 'expired') return APPROVAL_REFUSALS.cancelled;
    this.unanswered = true;
    return APPROVAL_REFUSALS.expired;
  }

  async consumeResults(): Promise<void> {
    try {
      await this.harness.consumeRuntimeResults();
    } catch (cause) {
      this.uncertain = true;
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  // #13856: the broker refused the release because a live background run
  // provably holds the Runtime — the designed hold, not a wedge. The turn
  // settles clean and the Runtime Session stays owed to the close, which
  // drains it; the busy path keeps the honesty contract untouched.
  private held = false;

  /** The turn ended with its Runtime Session held by a live run. */
  get runtimeHeld(): boolean {
    return this.held;
  }

  async finish(): Promise<void> {
    if (this.uncertain)
      throw new HostedToolRecoveryRequiredError('Tool outcome is unknown.');
    if (!this.acquired && !this.retiredOwnerResults) return;
    try {
      if (this.hookStopReason)
        await this.harness.settleHookStoppedRuntimeContinuation();
      else await this.harness.settleConsumedRuntimeContinuation();
      if (!this.acquired) return;
      // Physical release follows the durable Turn terminal on the G3 stack.
      if (!this.mcp && !this.hooks && !this.cleanupOwed)
        await this.broker.release();
      if (this.mcp || this.hooks || !this.cleanupOwed) this.acquired = false;
    } catch (cause) {
      if (
        cause instanceof HostedWorkspaceBrokerRejection &&
        cause.status === 409 &&
        cause.code === 'runtime_session_held'
      ) {
        this.held = true;
        this.acquired = false;
        return;
      }
      this.uncertain = true;
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  // The publisher lives on the Session across turns, so a turn's close
  // deliberately does not touch it: the Session's ordered close (H3's
  // fifth slice) drains the stores, and background traffic keeps its
  // endpoint until then.
  async cleanup(): Promise<void> {
    if (this.hooks || this.mcp) return;
    if (this.cleanupOwed)
      await reconcileHostedTurnCleanup(
        this.session,
        this.options,
        this.promptId,
      );
    else if (this.acquired) await this.broker.release();
    this.acquired = false;
  }

  async close(): Promise<void> {}
}

const HOSTED_GLOB_TRUNCATION_HINT =
  '\n---\n[Result truncated to fit the durable Session limit. Narrow the pattern or path.]';

/**
 * Keeps the longest whole-line prefix of a glob result that fits, followed by
 * a narrowing hint. Returns undefined when the response has no text output to
 * truncate or even the empty list does not fit.
 */
export function truncateHostedGlobResponse(
  parts: Part[],
  fits: (candidate: Part[]) => boolean,
): Part[] | undefined {
  const functionResponse = parts[0]?.functionResponse;
  const response = functionResponse?.response as
    | Record<string, unknown>
    | undefined;
  const output = response?.['output'];
  if (!functionResponse || !response || typeof output !== 'string')
    return undefined;
  const lines = output.split('\n');
  while (lines.length > 0) {
    const candidate: Part[] = [
      {
        functionResponse: {
          ...functionResponse,
          response: {
            ...response,
            output: lines.join('\n') + HOSTED_GLOB_TRUNCATION_HINT,
            outputTruncated: true,
          },
        },
      },
    ];
    if (fits(candidate)) return candidate;
    lines.pop();
  }
  return undefined;
}
