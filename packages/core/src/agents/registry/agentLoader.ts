/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { load } from 'js-yaml';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { semanticBoolean } from '../../utils/semanticBoolean.js';
import { repairYamlFrontmatter } from '../../utils/yaml-repair.js';
import {
  type AgentMcpServerSpec,
  type AgentDefinition,
  AGENT_COLORS,
} from '../types.js';
import { MCPServerConfig } from '../../mcp/mcpServerConfig.js';
// Note: tool name validation is not performed at parse time.
// Tool names are resolved at runtime by the tool registry.
import { getErrorMessage } from '../../utils/errors.js';
import {
  FRONTMATTER_REGEX,
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
  parseEffortValue,
} from '../../utils/frontmatterParsers.js';
import {
  loadAgentFromFile as loadAgentResourceFromFile,
  loadAgentsFromDirectory as loadAgentResourcesFromDirectory,
  loadAgentsFromPath as loadAgentResourcesFromPath,
  type AgentResourceDefinition,
} from '@qwen-code/resource';

/**
 * Error thrown when an agent definition is invalid or cannot be loaded.
 */
export class AgentLoadError extends Error {
  constructor(
    public filePath: string,
    message: string,
  ) {
    super(`Failed to load agent from ${filePath}: ${message}`);
    this.name = 'AgentLoadError';
  }
}

/** Result of loading agents from a filesystem source. */
export interface AgentLoadResult {
  agents: AgentDefinition[];
  errors: AgentLoadError[];
}

export interface AgentPathLoadResult extends AgentLoadResult {
  sourceType: 'file' | 'directory';
}

export interface AgentLoadOptions {
  namespace?: string[];
  pluginName?: string;
}

const nameSchema = z.string().min(1, 'Name must be a non-empty string');

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

const stringOrStringArray = z.union([z.string(), z.array(z.string())]);

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

const localAgentSchema = z
  .object({
    kind: z.literal('local').optional().default('local'),
    name: nameSchema,
    description: z.string().min(1),
    tools: stringOrStringArray.optional(),
    disallowedTools: stringOrStringArray.optional(),
    mcpServers: z
      .union([
        z.array(
          z.union([
            z.string(), // By-name reference to an already-configured server
            z.record(z.string(), mcpServerSchema), // Inline definition
          ]),
        ),
        z.record(z.string(), mcpServerSchema), // Object format
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
      .optional(), // Per-agent frontmatter hooks
    memory: z.enum(['user', 'project', 'local']).optional(), // Per-agent persistent memory scope
    background: semanticBoolean(z.boolean().optional()),
    isolation: z.literal('worktree').optional(),
  })
  .strip();

type FrontmatterLocalAgentDefinition = z.infer<typeof localAgentSchema> & {
  system_prompt: string;
};

type FrontmatterAgentDefinition = FrontmatterLocalAgentDefinition;

const markdownFrontmatterSchema = localAgentSchema;

function formatZodError(
  error: z.ZodError,
  context: string,
): string {
  const formatted = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('\n');
  return `${context}:\n${formatted}`;
}

/**
 * Parses and validates an agent Markdown file with frontmatter.
 *
 * @param filePath Path to the Markdown file.
 * @param content Optional pre-loaded content of the file.
 * @returns An array containing the single parsed agent definition.
 * @throws AgentLoadError if parsing or validation fails.
 */
export async function parseAgentMarkdown(
  filePath: string,
  content?: string,
): Promise<FrontmatterAgentDefinition[]> {
  let fileContent: string;
  if (content !== undefined) {
    fileContent = content;
  } else {
    try {
      fileContent = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      throw new AgentLoadError(
        filePath,
        `Could not read file: ${getErrorMessage(error)}`,
      );
    }
  }

  // Split frontmatter and body
  const match = fileContent.match(FRONTMATTER_REGEX);
  if (!match) {
    throw new AgentLoadError(
      filePath,
      'Invalid agent definition: Missing mandatory YAML frontmatter. Agent Markdown files MUST start with YAML frontmatter enclosed in triple-dashes "---" (e.g., ---\nname: my-agent\n---).',
    );
  }

  const frontmatterStr = match[1];
  const body = match[2] || '';

  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = load(frontmatterStr);
  } catch (error) {
    // Try repairing YAML before giving up (handles common LLM formatting issues)
    try {
      const repaired = repairYamlFrontmatter(frontmatterStr ?? '');
      rawFrontmatter = load(repaired);
    } catch {
      throw new AgentLoadError(
        filePath,
        `YAML frontmatter parsing failed: ${getErrorMessage(error)}`,
      );
    }
  }

  const result = markdownFrontmatterSchema.safeParse(rawFrontmatter);

  if (!result.success) {
    throw new AgentLoadError(
      filePath,
      `Validation failed: ${formatZodError(result.error, 'Agent Definition')}`,
    );
  }

  const frontmatter = result.data;

  return [
    {
      ...frontmatter,
      kind: 'local',
      system_prompt: body.trim(),
    },
  ];
}

/**
 * Converts a FrontmatterAgentDefinition DTO to the internal AgentDefinition structure.
 *
 * @param markdown The parsed Markdown/Frontmatter definition.
 * @param metadata Optional metadata including file path.
 * @returns The internal AgentDefinition.
 */
export function markdownToAgentDefinition(
  markdown: FrontmatterAgentDefinition,
  metadata?: { filePath?: string },
): AgentDefinition {
  const inputConfig = {
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The task for the agent.',
        },
      },
      // query is not required; when omitted, DEFAULT_QUERY_STRING is used as fallback
      required: [],
    },
  };

  // If a model is specified, use it. Otherwise, inherit
  const modelName = markdown.model || 'inherit';

  const mcpServerSpecs: AgentMcpServerSpec[] = [];
  if (markdown.mcpServers) {
    // Normalize: object format → wrap in array for uniform processing
    const rawSpecs = Array.isArray(markdown.mcpServers)
      ? markdown.mcpServers
      : [markdown.mcpServers];
    for (const spec of rawSpecs) {
      if (typeof spec === 'string') {
        // By-name reference — pass through as-is
        mcpServerSpecs.push(spec);
      } else {
        // Inline definition: { [name]: config }
        const inlineRecord: Record<string, MCPServerConfig> = {};
        for (const [name, config] of Object.entries(spec)) {
          inlineRecord[name] = new MCPServerConfig(
            config.command,
            config.args,
            config.env,
            config.cwd,
            config.url,
            config.http_url,
            config.headers,
            config.tcp,
            config.type,
            config.timeout,
            config.trust,
            config.description,
            config.include_tools,
            config.exclude_tools,
          );
        }
        mcpServerSpecs.push(inlineRecord);
      }
    }
  }

  const toolNames = parseAgentToolsFromFrontmatter(markdown.tools) ?? [];

  // Agents do not synthesize per-agent sampling parameters.
  // Preserve an explicitly configured temperature as an extension; all
  // omitted generation fields are resolved from the final model at runtime.
  const generateContentConfig: Record<string, unknown> = {};
  if (markdown.temperature !== undefined) {
    generateContentConfig['temperature'] = markdown.temperature;
  }
  const parsedEffort = parseEffortValue(markdown.effort);

  // initialPrompt is only used when this agent runs as the main-thread
  // (session) agent — it is NOT propagated to promptConfig.query, which would
  // incorrectly inject it into subagent call paths (browser, memory, etc.).
  const query = undefined;

  return {
    kind: 'local',
    name: markdown.name,
    description: markdown.description,
    color: markdown.color,
    promptConfig: {
      systemPrompt: markdown.system_prompt,
      query,
    },
    modelConfig: {
      model: modelName,
      ...(Object.keys(generateContentConfig).length > 0
        ? { generateContentConfig }
        : {}),
    },
    ...(markdown.maxTurns != null || markdown.timeoutMins != null
      ? {
          runConfig: {
            ...(markdown.maxTurns != null && { maxTurns: markdown.maxTurns }),
            ...(markdown.timeoutMins != null && {
              maxTimeMinutes: markdown.timeoutMins,
            }),
          },
        }
      : undefined),
    toolConfig:
      toolNames.length > 0
        ? {
            tools: toolNames,
          }
        : undefined,
    mcpServers: mcpServerSpecs.length > 0 ? mcpServerSpecs : undefined,
    inputConfig,
    metadata,

    disallowedTools: parseAgentToolsFromFrontmatter(markdown.disallowedTools),
    skills: parseSlashCommandToolsFromFrontmatter(markdown.skills),
    effort: parsedEffort,
    initialPrompt: markdown.initialPrompt,

    permissionMode: markdown.permissionMode,
    hooks: markdown.hooks,
    memory: markdown.memory, // Per-agent persistent memory (user or project scope)
    background: markdown.background,
    isolation: markdown.isolation,
  };
}

/**
 * Materializes a runtime-independent @qwen-code/resource Agent snapshot into the
 * existing CLI AgentDefinition. Runtime model/MCP classes and policy
 * remain owned by the CLI.
 */
export function agentResourceToAgentDefinition(
  resource: AgentResourceDefinition,
): AgentDefinition {
  return markdownToAgentDefinition(
    {
      kind: 'local',
      name: resource.name,
      description: resource.description,
      tools: resource.tools,
      disallowedTools: resource.disallowedTools,
      mcpServers: resource.mcpServers,
      model: resource.model,
      temperature: resource.temperature,
      maxTurns: resource.maxTurns,
      timeoutMins: resource.timeoutMins,
      skills: resource.skills,
      effort: resource.effort,
      color: resource.color,
      initialPrompt: resource.initialPrompt,
      permissionMode: resource.permissionMode,
      hooks: resource.hooks,
      memory: resource.memory,
      background: resource.background,
      isolation: resource.isolation,
      system_prompt: resource.prompt,
    },
    { filePath: resource.metadata.filePath },
  );
}

/**
 * Loads all agents from a specific directory.
 * Ignores files starting with _ and non-supported extensions.
 * Supported extensions: .md
 *
 * Recursively scans subdirectories, appending subdirectory names to the
 * namespace chain. When `pluginName` is provided, agent names are prefixed
 * with `pluginName:subdir:agentName` to avoid collisions across plugins.
 *
 * @param dir Directory path to scan.
 * @param options Optional namespace chain and plugin name for prefixing.
 * @returns Object containing successfully loaded agents and any errors.
 */
export async function loadAgentsFromDirectory(
  dir: string,
  options?: AgentLoadOptions,
): Promise<AgentLoadResult> {
  const loaded = await loadAgentResourcesFromDirectory(dir, {
    source: options?.pluginName ? 'plugin' : 'user',
    namespace: options?.namespace,
    pluginName: options?.pluginName,
  });
  return materializeAgentLoadResult(loaded);
}

/**
 * Load a single agent markdown file. Mirrors the per-file branch of
 * `loadAgentsFromDirectory` so callers handling manifest single-file agent
 * paths get the same plugin-name namespacing.
 */
export async function loadAgentFromFile(
  filePath: string,
  options?: Pick<AgentLoadOptions, 'pluginName'>,
): Promise<AgentLoadResult> {
  const loaded = await loadAgentResourceFromFile(filePath, {
    source: options?.pluginName ? 'plugin' : 'user',
    pluginName: options?.pluginName,
  });
  return materializeAgentLoadResult(loaded);
}

/**
 * Load plugin agents from a manifest or convention path.
 *
 * Plugin manifests declare Markdown files while convention discovery yields
 * an agents/ directory. Keep that distinction in one place so runtime
 * registration, validation, and resource inventory cannot drift apart.
 * Missing paths are ignored because plugin loading reports path diagnostics.
 */
export async function loadAgentsFromPath(
  sourcePath: string,
  options?: AgentLoadOptions,
): Promise<AgentPathLoadResult | undefined> {
  const loaded = await loadAgentResourcesFromPath(sourcePath, {
    source: options?.pluginName ? 'plugin' : 'user',
    namespace: options?.namespace,
    pluginName: options?.pluginName,
  });
  return loaded
    ? { ...materializeAgentLoadResult(loaded), sourceType: loaded.sourceType }
    : undefined;
}

function materializeAgentLoadResult(loaded: {
  agents: AgentResourceDefinition[];
  errors: Array<{ filePath: string; message: string }>;
}): AgentLoadResult {
  return {
    agents: loaded.agents.map(agentResourceToAgentDefinition),
    errors: loaded.errors.map(
      (error) =>
        new AgentLoadError(
          error.filePath,
          stripAgentLoadErrorPrefix(error.message, error.filePath),
        ),
    ),
  };
}

function stripAgentLoadErrorPrefix(message: string, filePath: string): string {
  const prefix = `Failed to load agent from ${filePath}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/**
 * Schema for a single agent definition in JSON format (used by --agents CLI flag).
 * Maps to the same fields as the markdown frontmatter schema.
 */
const agentJsonSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: stringOrStringArray.optional(),
  disallowedTools: stringOrStringArray.optional(),
  mcpServers: z
    .union([
      z.array(z.union([z.string(), z.record(z.string(), mcpServerSchema)])),
      z.record(z.string(), mcpServerSchema),
    ])
    .optional(),
  model: z.string().optional(),
  effort: effortSchema,
  color: z.enum(AGENT_COLORS).optional(),
  maxTurns: z.number().int().positive().optional(),
  initialPrompt: z.string().optional(),
  skills: stringOrStringArray.optional(),
  permissionMode: z.string().optional(),
  background: z.boolean().optional(),
  memory: z.enum(['user', 'project', 'local']).optional(),
  isolation: z.literal('worktree').optional(),
});

/**
 * Schema for the --agents JSON: a record of agent name → definition.
 */
const agentsJsonSchema = z.record(nameSchema, agentJsonSchema);

/**
 * Parses a JSON string into agent definitions.
 * Used by the --agents CLI flag for inline agent definitions.
 *
 * @param jsonString The raw JSON string from --agents flag.
 * @returns Array of parsed AgentDefinitions.
 */
export function parseAgentsFromJson(jsonString: string): AgentDefinition[] {
  return parseAgentsFromJsonValue(jsonString);
}

function parseAgentsFromJsonValue(jsonString: string): AgentDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new AgentLoadError('--agents', 'Invalid JSON in --agents flag');
  }

  const result = agentsJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentLoadError(
      '--agents',
      `Validation failed: ${result.error.message}`,
    );
  }

  const agents: AgentDefinition[] = [];
  for (const [name, def] of Object.entries(result.data)) {
    const frontmatter: FrontmatterLocalAgentDefinition = {
      kind: 'local',
      name,
      description: def.description,
      tools: def.tools,
      disallowedTools: def.disallowedTools,
      mcpServers: def.mcpServers,
      model: def.model,
      effort: def.effort,
      color: def.color,
      maxTurns: def.maxTurns,
      initialPrompt: def.initialPrompt,
      skills: def.skills,
      permissionMode: def.permissionMode,
      background: def.background,
      memory: def.memory,
      isolation: def.isolation,
      system_prompt: def.prompt,
    };
    agents.push(
      markdownToAgentDefinition(
        { ...frontmatter, kind: 'local' },
        { filePath: `--agents:${name}` },
      ),
    );
  }

  return agents;
}

/**
 * Converts SDK wire-format agent definitions (from the initialize
 * control_request's `agents` field) to internal AgentDefinition objects.
 *
 * The wire format (protocol/src/agents.ts AgentDefinition) is:
 *   Record<string, { description, prompt, tools?, model?, maxTurns?, mcpServers?, ... }>
 *
 * This is structurally compatible with the --agents JSON schema
 * (agentJsonSchema), so we serialize and delegate to parseAgentsFromJson().
 *
 * The wire format is validated by the same schema as --agents so SDK and CLI
 * definitions have identical runtime behavior.
 */
export function parseAgentsFromSdkInitialize(
  agents: Record<string, unknown>,
): AgentDefinition[] {
  return parseAgentsFromJson(JSON.stringify(agents));
}
