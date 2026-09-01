/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import {
  CODE_MODE_MAX_MEDIA_BYTES,
  CODE_MODE_MAX_MEDIA_ITEMS,
} from '../code-mode/protocol.js';
import type { AnyDeclarativeTool } from './tools.js';
import { ToolNames } from './tool-names.js';

export type ToolExposure =
  'exec' | 'direct-only' | 'code-mode-callable' | 'hidden';

export const ToolMode = {
  Direct: 'direct',
  CodeModeOnly: 'code_mode_only',
} as const;

export type ToolMode = (typeof ToolMode)[keyof typeof ToolMode];

const HIDDEN_TOOLS = new Set<string>([ToolNames.TOOL_SEARCH, 'tool_call']);

const DIRECT_ONLY_TOOLS = new Set<string>([
  ToolNames.AGENT,
  ToolNames.ASK_USER_QUESTION,
  ToolNames.STRUCTURED_OUTPUT,
  ToolNames.ENTER_PLAN_MODE,
  ToolNames.EXIT_PLAN_MODE,
  ToolNames.GET_GOAL,
  ToolNames.UPDATE_GOAL,
  ToolNames.TODO_WRITE,
  ToolNames.REPORT_FINDINGS,
  ToolNames.LIST_AGENTS,
  ToolNames.TASK_STOP,
  ToolNames.TASK_CREATE,
  ToolNames.TASK_UPDATE,
  ToolNames.TASK_LIST,
  ToolNames.TEAM_CREATE,
  ToolNames.TEAM_DELETE,
  ToolNames.TEAM_PLAN_APPROVAL,
  ToolNames.REQUEST_SHUTDOWN,
  ToolNames.SEND_MESSAGE,
  ToolNames.ENTER_WORKTREE,
  ToolNames.EXIT_WORKTREE,
  ToolNames.CREATE_SUB_SESSION,
  ToolNames.CRON_CREATE,
  ToolNames.CRON_LIST,
  ToolNames.CRON_DELETE,
  ToolNames.LOOP_WAKEUP,
  ToolNames.MONITOR,
  ToolNames.WORKFLOW,
  'capture_screen_context',
  'speak_to_user',
  'list_threads',
  'read_thread',
  'wait_threads',
  'send_message_to_thread',
  'create_thread',
]);

export function getToolExposure(name: string): ToolExposure {
  if (name === ToolNames.EXEC) return 'exec';
  if (HIDDEN_TOOLS.has(name)) return 'hidden';
  if (DIRECT_ONLY_TOOLS.has(name)) return 'direct-only';
  return 'code-mode-callable';
}

export function isCodeModeToolCallAllowed(
  name: string,
  source: 'model' | 'code_mode',
  allowedNames?: ReadonlySet<string>,
): boolean {
  const exposure = getToolExposure(name);
  return source === 'code_mode'
    ? exposure === 'code-mode-callable' &&
        (!allowedNames || allowedNames.has(name))
    : exposure === 'exec' || exposure === 'direct-only';
}

export interface CodeModeToolBinding {
  name: string;
  jsName: string;
  description: string;
  parametersJsonSchema: unknown;
  deferred: boolean;
}

export interface CodeModeBindingPlan {
  bindings: CodeModeToolBinding[];
  collisions: Array<{
    jsName: string;
    kept: string;
    omitted: string;
  }>;
}

export function normalizeCodeModeToolName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_$]/g, '_');
  if (normalized.length === 0) return '_';
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
}

export function planCodeModeBindings(
  tools: AnyDeclarativeTool[],
  isDeferred: (name: string) => boolean,
  allowedNames?: ReadonlySet<string>,
): CodeModeBindingPlan {
  const bindings: CodeModeToolBinding[] = [];
  const collisions: CodeModeBindingPlan['collisions'] = [];
  const claimed = new Map<string, string>();
  const sorted = [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  for (const tool of sorted) {
    if (getToolExposure(tool.name) !== 'code-mode-callable') continue;
    if (allowedNames && !allowedNames.has(tool.name)) continue;
    const jsName = normalizeCodeModeToolName(tool.name);
    const kept = claimed.get(jsName);
    if (kept) {
      collisions.push({ jsName, kept, omitted: tool.name });
      continue;
    }
    claimed.set(jsName, tool.name);
    bindings.push({
      name: tool.name,
      jsName,
      description: tool.description,
      parametersJsonSchema: tool.schema.parametersJsonSchema,
      deferred: isDeferred(tool.name),
    });
  }

  return { bindings, collisions };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function literal(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function schemaToType(schema: unknown): string {
  const node = asRecord(schema);
  if (!node) return 'unknown';

  const variants = Array.isArray(node['anyOf'])
    ? node['anyOf']
    : Array.isArray(node['oneOf'])
      ? node['oneOf']
      : undefined;
  if (variants) {
    return variants.map(schemaToType).join(' | ');
  }
  if (Array.isArray(node['enum'])) {
    return node['enum'].map(literal).join(' | ') || 'unknown';
  }
  if ('const' in node) return literal(node['const']);

  const type = node['type'];
  if (Array.isArray(type)) {
    return type
      .map((item) => schemaToType({ ...node, type: item }))
      .join(' | ');
  }
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') {
    const bounds: string[] = [];
    if (typeof node['minimum'] === 'number') {
      bounds.push(`min ${node['minimum']}`);
    }
    if (typeof node['maximum'] === 'number') {
      bounds.push(`max ${node['maximum']}`);
    }
    return bounds.length > 0 ? `number /* ${bounds.join(', ')} */` : 'number';
  }
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  if (type === 'array') return `Array<${schemaToType(node['items'])}>`;
  if (type === 'object' || node['properties']) {
    const properties = asRecord(node['properties']) ?? {};
    const required = new Set(
      Array.isArray(node['required'])
        ? node['required'].filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    );
    const fields = Object.keys(properties)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        (name) =>
          `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${schemaToType(properties[name])}`,
      );
    if (
      node['additionalProperties'] &&
      node['additionalProperties'] !== false
    ) {
      fields.push(
        `[key: string]: ${schemaToType(node['additionalProperties'])}`,
      );
    }
    return `{ ${fields.join('; ')} }`;
  }
  return 'unknown';
}

function describeBinding(binding: CodeModeToolBinding): string {
  // A deferred tool keeps its registry semantics, but CodeModeOnly hides
  // tool_search and never surfaces nested calls as history functionCalls, so
  // nothing can reveal it later: this description is its only chance to carry
  // a schema.
  const params = schemaToType(binding.parametersJsonSchema);
  return `tools.${binding.jsName}(args: ${params}): Promise<CodeModeToolResult>;`;
}

export function buildExecDescription(plan: CodeModeBindingPlan): string {
  const allTools = plan.bindings.map(
    ({ name, jsName, description, deferred }) => ({
      name,
      jsName,
      description,
      deferred,
    }),
  );
  const collisionText = plan.collisions
    .map(
      ({ jsName, kept, omitted }) =>
        `- ${omitted} is omitted because it collides with ${kept} as tools.${jsName}.`,
    )
    .join('\n');
  const declarations = plan.bindings.map(describeBinding).join('\n');

  return `Execute JavaScript in a fresh isolated runtime and wait for it to finish.

Use async/await and call registered tools through tools.<name>(args). Calls use the same validation, permissions, approvals, hooks, telemetry, cancellation, concurrency, and output limits as direct tool calls. Tool calls can be composed with Promise.all. Await every tool promise; unawaited calls are cancelled when the script finishes. The exec tool, direct control tools, tool_search, and tool_call are not callable through tools.

Available globals:
- tools: the code-mode-callable tool functions declared below.
- ALL_TOOLS: frozen metadata for every function in tools.
- text(value): append bounded text output. Non-string values are JSON-stringified when possible.
- image(imageUrlOrItem: string | ImageContent): append an image from a base64 data URL or Qwen MCP ImageContent. To return a nested MCP image, pass an item such as image(result.content[0]).
- audio(dataUrl: string): append audio from a base64 data URL with an audio MIME type.
- generatedImage(result: CodeModeToolResult): append the image and saved-path hint returned by Qwen's built-in image_gen tool, for example generatedImage(await tools.image_gen({ prompt: '...' })).
- setTimeout(callback: () => void, delayMs?: number): schedule a callback to run later and return a timeout id. Pending timeouts do not keep exec alive by themselves; await an explicit promise if you need to wait for one.
- clearTimeout(timeoutId?: number): cancel a timeout created by setTimeout.
- exit(): finish immediately.

Media helpers share a limit of ${CODE_MODE_MAX_MEDIA_ITEMS} items and ${CODE_MODE_MAX_MEDIA_BYTES / (1024 * 1024)} MiB of decoded base64 data per exec call.

There is no Node.js, process, require, filesystem, network, import, console, WebAssembly, Atomics, or persistent state. Static and dynamic imports are unsupported. Every exec call gets a new runtime.

type ImageContent = { type: 'image'; data: string; mimeType: string };
type CodeModeToolResult = { callId: string; name: string; status: 'success'; output: string; content?: ImageContent[] };
${declarations || '// No ordinary tools are available in this context.'}

const ALL_TOOLS = ${JSON.stringify(allTools)} as const;
${collisionText ? `\nName collisions:\n${collisionText}` : ''}`;
}

export function buildExecDeclaration(
  execTool: AnyDeclarativeTool,
  plan: CodeModeBindingPlan,
): FunctionDeclaration {
  return {
    ...execTool.schema,
    description: buildExecDescription(plan),
  };
}
