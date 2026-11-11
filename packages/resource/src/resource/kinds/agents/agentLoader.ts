/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';
import {
  parseSlashCommandToolsFromFrontmatter,
  parseToolListString,
} from '../skills/frontmatterParsers.js';
import { repairYamlFrontmatter } from '../skills/yamlRepair.js';
import {
  AGENT_COLORS,
  AGENT_KINDS,
  type AgentLoadResult,
  type AgentMcpServerConfig,
  type AgentMcpServerSpec,
  type AgentPathLoadResult,
  type AgentResourceDefinition,
  type AgentResourceLoadError,
  type AgentResourceSource,
} from './types.js';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/;

const nameSchema = z.string().min(1, 'Name must be a non-empty string');
const stringOrStringArray = z.union([z.string(), z.array(z.string())]);
const mcpServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  http_url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  tcp: z.string().optional(),
  type: z.enum(['sse', 'http']).optional(),
  timeout: z.number().optional(),
  trust: z.boolean().optional(),
  description: z.string().optional(),
  include_tools: z.array(z.string()).optional(),
  exclude_tools: z.array(z.string()).optional(),
});
const hookBaseFields = {
  timeout: z.number().optional(),
  if: z.string().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
};
const effortSchema = z
  .union([
    z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    z.number().int().positive(),
  ])
  .optional();
const agentFrontmatterSchema = z
  .object({
    kind: z.enum(AGENT_KINDS).optional().default('local'),
    name: nameSchema,
    description: z.string().min(1),
    tools: stringOrStringArray.optional(),
    disallowedTools: stringOrStringArray.optional(),
    mcpServers: z
      .union([
        z.array(z.union([z.string(), z.record(z.string(), mcpServerSchema)])),
        z.record(z.string(), mcpServerSchema),
      ])
      .optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    maxTurns: z.number().int().positive().optional(),
    timeoutMins: z.number().int().positive().optional(),
    skills: stringOrStringArray.optional(),
    effort: effortSchema,
    color: z.enum(AGENT_COLORS).optional(),
    initialPrompt: z.string().optional(),
    permissionMode: z.string().optional(),
    hooks: z
      .record(
        z.string(),
        z.array(
          z.object({
            matcher: z.string().optional(),
            hooks: z.array(
              z.union([
                z.object({
                  ...hookBaseFields,
                  type: z.literal('command'),
                  command: z.string(),
                  shell: z.string().optional(),
                  args: z.array(z.string()).optional(),
                  async: z.boolean().optional(),
                  asyncRewake: z.boolean().optional(),
                  rewakeMessage: z.string().optional(),
                  rewakeSummary: z.string().optional(),
                }),
                z.object({
                  ...hookBaseFields,
                  type: z.literal('http'),
                  url: z.string(),
                  headers: z.record(z.string()).optional(),
                  allowedEnvVars: z.array(z.string()).optional(),
                }),
                z.object({
                  ...hookBaseFields,
                  type: z.literal('prompt'),
                  prompt: z.string(),
                  model: z.string().optional(),
                }),
                z.object({
                  ...hookBaseFields,
                  type: z.literal('agent'),
                  prompt: z.string(),
                  model: z.string().optional(),
                }),
              ]),
            ),
          }),
        ),
      )
      .optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    background: semanticBoolean(z.boolean().optional()),
    isolation: z.literal('worktree').optional(),
  })
  .strip();

type ParsedAgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

export interface AgentLoadOptions {
  source: AgentResourceSource;
  namespace?: string[];
  pluginName?: string;
}

export class AgentLoadError extends Error {
  constructor(
    readonly filePath: string,
    readonly source: AgentResourceSource,
    message: string,
  ) {
    super(`Failed to load agent from ${filePath}: ${message}`);
    this.name = 'AgentLoadError';
  }
}

export async function parseAgentMarkdown(
  filePath: string,
  source: AgentResourceSource,
  content?: string,
): Promise<AgentResourceDefinition> {
  let fileContent: string;
  try {
    fileContent = content ?? (await fs.readFile(filePath, 'utf-8'));
  } catch (error) {
    throw new AgentLoadError(
      filePath,
      source,
      `Could not read file: ${getErrorMessage(error)}`,
    );
  }

  const match = fileContent.match(FRONTMATTER_REGEX);
  if (!match) {
    throw new AgentLoadError(
      filePath,
      source,
      'Invalid agent definition: Missing mandatory YAML frontmatter. Agent Markdown files MUST start with YAML frontmatter enclosed in triple-dashes "---".',
    );
  }

  const frontmatterText = match[1] ?? '';
  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = load(frontmatterText);
  } catch (error) {
    try {
      rawFrontmatter = load(repairYamlFrontmatter(frontmatterText));
    } catch {
      throw new AgentLoadError(
        filePath,
        source,
        `YAML frontmatter parsing failed: ${getErrorMessage(error)}`,
      );
    }
  }

  const result = agentFrontmatterSchema.safeParse(rawFrontmatter);
  if (!result.success) {
    throw new AgentLoadError(
      filePath,
      source,
      `Validation failed: ${formatZodError(result.error)}`,
    );
  }
  return toAgentResourceDefinition(
    result.data,
    (match[2] ?? '').trim(),
    filePath,
    source,
  );
}

export async function loadAgentsFromDirectory(
  directory: string,
  options: AgentLoadOptions,
): Promise<AgentLoadResult> {
  const result: AgentLoadResult = { agents: [], errors: [] };
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return result;
    }
    result.errors.push(
      toLoadError(
        new AgentLoadError(
          directory,
          options.source,
          `Could not list directory: ${getErrorMessage(error)}`,
        ),
      ),
    );
    return result;
  }

  const files = entries.filter(
    (entry) =>
      entry.isFile() &&
      !entry.name.startsWith('_') &&
      entry.name.endsWith('.md'),
  );
  const subdirectories = entries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('_'),
  );

  for (const entry of files) {
    const filePath = path.join(directory, entry.name);
    try {
      const agent = await parseAgentMarkdown(filePath, options.source);
      if (options.pluginName) {
        agent.name = [
          options.pluginName,
          ...(options.namespace ?? []),
          agent.name,
        ].join(':');
      }
      result.agents.push(agent);
    } catch (error) {
      result.errors.push(
        error instanceof AgentLoadError
          ? toLoadError(error)
          : toLoadError(
              new AgentLoadError(
                filePath,
                options.source,
                `Unexpected error: ${getErrorMessage(error)}`,
              ),
            ),
      );
    }
  }

  for (const entry of subdirectories) {
    const nested = await loadAgentsFromDirectory(
      path.join(directory, entry.name),
      {
        ...options,
        namespace: [...(options.namespace ?? []), entry.name],
      },
    );
    result.agents.push(...nested.agents);
    result.errors.push(...nested.errors);
  }

  return result;
}

export async function loadAgentFromFile(
  filePath: string,
  options: AgentLoadOptions,
): Promise<AgentLoadResult> {
  const result: AgentLoadResult = { agents: [], errors: [] };
  try {
    const agent = await parseAgentMarkdown(filePath, options.source);
    if (options.pluginName) agent.name = `${options.pluginName}:${agent.name}`;
    result.agents.push(agent);
  } catch (error) {
    result.errors.push(
      error instanceof AgentLoadError
        ? toLoadError(error)
        : toLoadError(
            new AgentLoadError(
              filePath,
              options.source,
              `Unexpected error: ${getErrorMessage(error)}`,
            ),
          ),
    );
  }
  return result;
}

export async function loadAgentsFromPath(
  sourcePath: string,
  options: AgentLoadOptions,
): Promise<AgentPathLoadResult | undefined> {
  const sourceStat = await fs.stat(sourcePath).catch(() => undefined);
  if (!sourceStat) return undefined;
  const sourceType =
    sourceStat.isFile() && sourcePath.endsWith('.md') ? 'file' : 'directory';
  const result =
    sourceType === 'file'
      ? await loadAgentFromFile(sourcePath, options)
      : await loadAgentsFromDirectory(sourcePath, options);
  return { ...result, sourceType };
}

function toAgentResourceDefinition(
  parsed: ParsedAgentFrontmatter,
  prompt: string,
  filePath: string,
  source: AgentResourceSource,
): AgentResourceDefinition {
  const tools = parseToolListString(parsed.tools) ?? undefined;
  const disallowedTools =
    parseToolListString(parsed.disallowedTools) ?? undefined;
  return {
    kind: parsed.kind,
    name: parsed.name,
    description: parsed.description,
    prompt,
    color: parsed.color,
    tools,
    disallowedTools,
    mcpServers: normalizeMcpServers(parsed.mcpServers),
    model: parsed.model,
    temperature: parsed.temperature,
    maxTurns: parsed.maxTurns,
    timeoutMins: parsed.timeoutMins,
    skills: parseSlashCommandToolsFromFrontmatter(parsed.skills),
    effort: parsed.effort,
    initialPrompt: parsed.initialPrompt,
    permissionMode: parsed.permissionMode,
    hooks: parsed.hooks,
    memory: parsed.memory,
    background: parsed.background,
    isolation: parsed.isolation,
    metadata: { filePath, source },
  };
}

function normalizeMcpServers(
  value:
    | string[]
    | Array<string | Record<string, AgentMcpServerConfig>>
    | Record<string, AgentMcpServerConfig>
    | undefined,
): AgentMcpServerSpec[] | undefined {
  if (!value) return undefined;
  const specs = Array.isArray(value) ? value : [value];
  return specs.length > 0 ? specs : undefined;
}

function semanticBoolean<T extends z.ZodType>(
  inner: T,
): z.ZodEffects<T, z.output<T>, unknown> {
  return z.preprocess(
    (value: unknown) =>
      value === 'true' ? true : value === 'false' ? false : value,
    inner,
  );
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${location}${issue.message}`;
    })
    .join('\n');
}

function toLoadError(error: AgentLoadError): AgentResourceLoadError {
  return {
    filePath: error.filePath,
    message: error.message,
    source: error.source,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
