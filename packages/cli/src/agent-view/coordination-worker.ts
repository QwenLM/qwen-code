/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  QwenIgnoreParser,
  ToolNames,
  type ToolInvocationGuard,
} from '@qwen-code/qwen-code-core';
import type { CliArgs } from '../config/config.js';
import type { CLIResultMessage } from '../nonInteractive/types.js';
import {
  AGENT_VIEW_MAX_RESULT_BYTES,
  AGENT_VIEW_MAX_TASK_BYTES,
  type AgentViewCoordinationOutcome,
} from './protocol.js';
import {
  QWEN_AGENT_VIEW_ATTEMPT_ID,
  QWEN_AGENT_VIEW_COORDINATION_MODE,
  QWEN_AGENT_VIEW_INPUT_SNAPSHOT,
  QWEN_AGENT_VIEW_PROJECT_CWD,
  QWEN_AGENT_VIEW_PROMPT_ID,
  QWEN_AGENT_VIEW_TASK_PATH,
  readAgentViewCoordinationWorkerEnv,
  type AgentViewCoordinationWorkerEnv,
} from './worker-sideband.js';
import {
  captureAgentViewInputSnapshot,
  isAgentViewSnapshottedPath,
} from './input-snapshot.js';

const MAX_ARTIFACTS = 64;
const MAX_ARTIFACT_BYTES = 4_096;
const MANAGED_RESULT_KEYS = new Set(['outcome', 'summary', 'artifacts']);
const PATH_ARGUMENT_BY_TOOL: Readonly<Record<string, 'file_path' | 'path'>> = {
  [ToolNames.READ_FILE]: 'file_path',
  [ToolNames.EDIT]: 'file_path',
  [ToolNames.WRITE_FILE]: 'file_path',
  [ToolNames.GREP]: 'path',
  [ToolNames.GLOB]: 'path',
  [ToolNames.LS]: 'path',
};

export interface ManagedCoordinationWorker {
  coordination: AgentViewCoordinationWorkerEnv;
  argv: CliArgs;
  task: string;
}

export interface ManagedCoordinationResult {
  outcome: AgentViewCoordinationOutcome;
  summary: string;
  artifacts: string[];
}

export async function prepareManagedCoordinationWorker(
  argv: CliArgs,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<ManagedCoordinationWorker | undefined> {
  const coordination = readAgentViewCoordinationWorkerEnv(env);
  if (!coordination) {
    if (hasCoordinationMarker(env)) {
      throw new Error('Invalid managed coordination worker environment.');
    }
    return undefined;
  }

  await requireMatchingActiveCwd(coordination.sideband.activeCwd, cwd);
  validateManagedWorkerArguments(argv, coordination);
  const task = await readManagedTask(coordination.taskPath);
  const prompt = `${task.trim()}\n\nReturn exactly one JSON object and no other text: {"outcome":"completed"|"handback","summary":"concise evidence or handback reason","artifacts":["absolute paths inside the active workspace"]}. Use handback only when the assignment cannot be completed safely with the available tools.`;

  return {
    coordination,
    task,
    argv: {
      ...argv,
      model: argv.model ?? env['QWEN_CODE_MODEL'],
      query: undefined,
      prompt,
      promptInteractive: undefined,
      systemPrompt: undefined,
      appendSystemPrompt:
        'You are a supervisor-managed Qwen coordination worker. Do not delegate, start background work, access external services, or ask the terminal user. Stay inside the active workspace and finish with the exact JSON object requested by the task.',
      sandbox: false,
      sandboxImage: undefined,
      yolo: true,
      approvalMode: 'yolo',
      bare: false,
      safeMode: true,
      allowedMcpServerNames: [],
      mcpConfig: undefined,
      allowedTools: undefined,
      coreTools: undefined,
      excludeTools: undefined,
      acp: false,
      experimentalAcp: false,
      experimentalLsp: false,
      extensions: [],
      includeDirectories: [],
      listExtensions: false,
      inputFormat: 'text',
      outputFormat: 'json',
      includePartialMessages: false,
      chatRecording: false,
      continue: false,
      resume: undefined,
      forkSession: false,
      sandboxSessionId: undefined,
      worktree: undefined,
      sessionId: coordination.sideband.sessionId,
      maxSessionTurns: 12,
      maxWallTime: '10m',
      maxToolCalls: 60,
      maxSubagentDepth: 1,
      jsonFd: undefined,
      jsonFile: undefined,
      jsonSchema: undefined,
      inputFile: undefined,
      background: false,
    },
  };
}

export async function createManagedCoordinationPathGuard(
  activeCwd: string,
  customIgnoreFiles?: readonly string[],
  writeMode: AgentViewCoordinationWorkerEnv['writeMode'] = 'read-only',
  policySourceCwd: string = activeCwd,
  expectedInputSnapshot?: string,
): Promise<ToolInvocationGuard> {
  const [root, policySourceRoot] = await Promise.all([
    fs.realpath(activeCwd),
    fs.realpath(policySourceCwd),
  ]);
  const ignoreFileNames = new QwenIgnoreParser(
    policySourceRoot,
    customIgnoreFiles,
  ).getIgnoreFileNames();
  if (writeMode === 'isolated-writer') {
    await requireMatchingIgnorePolicy(policySourceRoot, root, ignoreFileNames);
  }
  const qwenIgnore = new QwenIgnoreParser(root, customIgnoreFiles);
  const immutableIgnorePaths = new Set(
    ignoreFileNames.map((fileName) =>
      path.resolve(root, fileName).toLowerCase(),
    ),
  );
  const immutableSearchIgnoreNames = new Set([
    '.gitignore',
    '.ignore',
    '.rgignore',
  ]);
  let inputChanged = false;
  return async ({ toolName, args }) => {
    const pathKey = PATH_ARGUMENT_BY_TOOL[toolName];
    if (!pathKey) {
      return {
        allowed: false,
        reason: 'Tool is outside managed coordination policy.',
      };
    }
    if (expectedInputSnapshot && !inputChanged) {
      inputChanged =
        (await captureAgentViewInputSnapshot(policySourceRoot)) !==
        expectedInputSnapshot;
    }
    if (inputChanged) {
      return {
        allowed: false,
        reason:
          'Managed coordination input changed after dispatch; collect and reassign the task.',
      };
    }
    if (toolName === ToolNames.LS) {
      const filtering = args['file_filtering_options'];
      if (
        isRecord(filtering) &&
        (filtering['respect_git_ignore'] === false ||
          filtering['respect_qwen_ignore'] === false)
      ) {
        return {
          allowed: false,
          reason: 'Managed coordination must respect workspace ignore files.',
        };
      }
    }
    if (toolName === ToolNames.GREP && args['glob'] !== undefined) {
      return {
        allowed: false,
        reason:
          'Managed coordination grep cannot override workspace ignore files.',
      };
    }
    if (
      toolName === ToolNames.GLOB &&
      !isSafeManagedGlobPattern(args['pattern'])
    ) {
      return {
        allowed: false,
        reason:
          'Managed coordination glob patterns must stay inside the active workspace.',
      };
    }
    const value = args[pathKey];
    if (
      value === undefined &&
      (toolName === ToolNames.GREP || toolName === ToolNames.GLOB)
    ) {
      return { allowed: true };
    }
    if (typeof value !== 'string' || !value.trim()) {
      return {
        allowed: false,
        reason: 'Managed coordination requires an explicit workspace path.',
      };
    }
    const resolvedPath = await resolveManagedPath(root, value);
    if (!resolvedPath) {
      return {
        allowed: false,
        reason:
          'Managed coordination cannot access paths outside its active workspace.',
      };
    }
    if (
      writeMode === 'isolated-writer' &&
      (toolName === ToolNames.EDIT || toolName === ToolNames.WRITE_FILE) &&
      (immutableIgnorePaths.has(resolvedPath.toLowerCase()) ||
        immutableSearchIgnoreNames.has(
          path.basename(resolvedPath).toLowerCase(),
        ))
    ) {
      return {
        allowed: false,
        reason: 'Managed coordination cannot modify its ignore policy.',
      };
    }
    if (
      qwenIgnore.isIgnored(resolvedPath) ||
      !(await isAgentViewSnapshottedPath(
        writeMode === 'isolated-writer' ? policySourceRoot : root,
        writeMode === 'isolated-writer'
          ? path.resolve(policySourceRoot, path.relative(root, resolvedPath))
          : resolvedPath,
      ))
    ) {
      return {
        allowed: false,
        reason:
          'Managed coordination cannot access Git metadata or ignored paths.',
      };
    }
    return { allowed: true };
  };
}

async function requireMatchingIgnorePolicy(
  sourceRoot: string,
  activeRoot: string,
  ignoreFileNames: readonly string[],
): Promise<void> {
  for (const fileName of ignoreFileNames) {
    const [source, active] = await Promise.all([
      readIgnorePolicyFile(sourceRoot, fileName),
      readIgnorePolicyFile(activeRoot, fileName),
    ]);
    if (source === undefined && active === undefined) continue;
    if (!source || !active || !source.equals(active)) {
      throw new Error(
        `Isolated coordination writer ignore policy differs from the source checkout: ${fileName}`,
      );
    }
  }
}

async function readIgnorePolicyFile(
  root: string,
  fileName: string,
): Promise<Buffer | undefined> {
  const filePath = path.resolve(root, fileName);
  if (!isWithin(root, filePath)) {
    throw new Error(
      'Managed coordination ignore policy escapes its workspace.',
    );
  }
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Managed coordination ignore policy must be a regular file: ${fileName}`,
    );
  }
  return fs.readFile(filePath);
}

export function parseManagedCoordinationResult(
  result: CLIResultMessage | undefined,
): ManagedCoordinationResult {
  if (!result)
    return failedResult('Managed worker produced no terminal result.');
  if (result.is_error) {
    return failedResult(result.error?.message ?? 'Managed worker failed.');
  }
  if (Buffer.byteLength(result.result, 'utf8') > AGENT_VIEW_MAX_RESULT_BYTES) {
    return failedResult(
      'Managed worker result exceeded the result size limit.',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(result.result);
  } catch {
    return failedResult(
      'Managed worker did not return the required JSON object.',
    );
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !MANAGED_RESULT_KEYS.has(key))
  ) {
    return failedResult('Managed worker returned an invalid result object.');
  }
  const outcome = value['outcome'];
  const summary = value['summary'];
  const artifacts = value['artifacts'];
  if (
    (outcome !== 'completed' && outcome !== 'handback') ||
    typeof summary !== 'string' ||
    !summary.trim() ||
    !Array.isArray(artifacts) ||
    artifacts.length > MAX_ARTIFACTS ||
    artifacts.some(
      (artifact) =>
        typeof artifact !== 'string' ||
        !artifact.trim() ||
        !path.isAbsolute(artifact) ||
        Buffer.byteLength(artifact, 'utf8') > MAX_ARTIFACT_BYTES,
    )
  ) {
    return failedResult('Managed worker returned an invalid result object.');
  }
  if (Buffer.byteLength(summary, 'utf8') > AGENT_VIEW_MAX_RESULT_BYTES) {
    return failedResult(
      'Managed worker summary exceeded the result size limit.',
    );
  }
  return {
    outcome,
    summary: summary.trim(),
    artifacts: artifacts.map((artifact) => String(artifact)),
  };
}

function isSafeManagedGlobPattern(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (value.includes('..') || value.includes(':')) return false;
  return !/(?:^|[,{(|])\s*[\\/]/.test(value);
}

function validateManagedWorkerArguments(
  argv: CliArgs,
  coordination: AgentViewCoordinationWorkerEnv,
): void {
  const conflicts: Array<[boolean, string]> = [
    [Boolean(argv.query || argv.prompt), 'prompt/query'],
    [argv.background === true, 'background'],
    [Boolean(argv.acp || argv.experimentalAcp), 'ACP'],
    [argv.continue === true, 'continue'],
    [argv.resume !== undefined, 'resume'],
    [argv.forkSession === true, 'fork'],
    [argv.worktree !== undefined, 'worktree'],
    [argv.promptInteractive !== undefined, 'prompt-interactive'],
    [argv.sandboxSessionId !== undefined, 'sandbox-session-id'],
    [argv.sandbox !== undefined, 'sandbox'],
    [argv.inputFormat === 'stream-json', 'stream-json'],
    [argv.mcpConfig !== undefined, 'MCP config'],
    [Boolean(argv.extensions?.length), 'extensions'],
    [Boolean(argv.includeDirectories?.length), 'include directories'],
    [argv.experimentalLsp === true, 'LSP'],
    [argv.inputFile !== undefined, 'input file'],
    [
      argv.jsonFd !== undefined || argv.jsonFile !== undefined,
      'JSON output destination',
    ],
    [argv.jsonSchema !== undefined, 'JSON schema'],
    [
      argv.systemPrompt !== undefined || argv.appendSystemPrompt !== undefined,
      'system prompt',
    ],
    [
      argv.sessionId !== undefined &&
        argv.sessionId !== coordination.sideband.sessionId,
      'session ID',
    ],
  ];
  const conflict = conflicts.find(([present]) => present);
  if (conflict) {
    throw new Error(
      `Managed coordination worker rejects ${conflict[1]} overrides.`,
    );
  }
}

async function readManagedTask(taskPath: string): Promise<string> {
  const stat = await fs.lstat(taskPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Managed coordination task must be a regular file.');
  }
  if (stat.size < 1 || stat.size > AGENT_VIEW_MAX_TASK_BYTES) {
    throw new Error(
      `Managed coordination task must be 1-${AGENT_VIEW_MAX_TASK_BYTES} bytes.`,
    );
  }
  const task = await fs.readFile(taskPath, 'utf8');
  if (!task.trim() || task.includes('\0')) {
    throw new Error('Managed coordination task is empty or invalid.');
  }
  return task;
}

function hasCoordinationMarker(env: NodeJS.ProcessEnv): boolean {
  return [
    QWEN_AGENT_VIEW_COORDINATION_MODE,
    QWEN_AGENT_VIEW_PROJECT_CWD,
    QWEN_AGENT_VIEW_TASK_PATH,
    QWEN_AGENT_VIEW_PROMPT_ID,
    QWEN_AGENT_VIEW_ATTEMPT_ID,
    QWEN_AGENT_VIEW_INPUT_SNAPSHOT,
  ].some((key) => env[key] !== undefined);
}

async function requireMatchingActiveCwd(
  expected: string,
  cwd: string,
): Promise<void> {
  const [expectedReal, actualReal] = await Promise.all([
    fs.realpath(expected),
    fs.realpath(cwd),
  ]);
  if (expectedReal !== actualReal) {
    throw new Error(
      'Managed coordination active workspace does not match process cwd.',
    );
  }
}

async function resolveManagedPath(
  root: string,
  rawPath: string,
): Promise<string | undefined> {
  const candidate = path.resolve(root, rawPath);
  if (!isWithin(root, candidate)) return undefined;
  let existing = candidate;
  const missingSuffix: string[] = [];
  while (true) {
    try {
      const resolved = await fs.realpath(existing);
      const resolvedCandidate = path.join(resolved, ...missingSuffix);
      return isWithin(root, resolvedCandidate) ? resolvedCandidate : undefined;
    } catch (error) {
      if (!isNotFound(error)) return undefined;
      try {
        await fs.lstat(existing);
        return undefined;
      } catch (statError) {
        if (!isNotFound(statError)) return undefined;
      }
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      missingSuffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function failedResult(summary: string): ManagedCoordinationResult {
  return {
    outcome: 'failed',
    summary: truncateUtf8(summary, AGENT_VIEW_MAX_RESULT_BYTES),
    artifacts: [],
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.byteLength <= maxBytes
    ? value
    : bytes.subarray(0, maxBytes).toString('utf8');
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
