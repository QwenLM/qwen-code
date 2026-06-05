/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentParameters } from '@google/genai';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';

export interface RuntimeDiagnosticsSnapshot {
  enabled: boolean;
  startedAt: string;
  requests: GenerateContentRequestDiagnostics[];
  openaiWireRequests: OpenAIWireRequestDiagnostics[];
  anthropicWireRequests: AnthropicWireRequestDiagnostics[];
  tools: RuntimeToolDiagnostics;
}

export interface GenerateContentRequestDiagnostics {
  index: number;
  timestamp: string;
  source: 'generateContent' | 'generateContentStream';
  model: string;
  stream: boolean;
  serializedBytes: number;
  contents: RuntimeContentDiagnostics;
  systemInstructionBytes: number;
  generationConfigBytes: number;
  tools: RuntimeToolSchemaDiagnostics;
}

export interface RuntimeContentDiagnostics {
  count: number;
  roleCounts: Record<string, number>;
  partCount: number;
  textBytes: number;
  functionCallCount: number;
  functionCallArgBytes: number;
  functionResponseCount: number;
  functionResponseBytes: number;
  inlineDataCount: number;
  inlineDataBytes: number;
  fileDataCount: number;
}

export interface RuntimeToolSchemaDiagnostics {
  count: number;
  functionDeclarationCount: number;
  schemaBytes: number;
}

export interface OpenAIWireRequestDiagnostics {
  index?: number;
  timestamp?: string;
  model: string;
  stream: boolean;
  bodyBytes: number;
  messageCount: number;
  messageBytesByRole: Record<string, number>;
  toolsCount: number;
  toolSchemaBytes: number;
  topLevelKeys: string[];
}

export interface AnthropicWireRequestDiagnostics {
  index?: number;
  timestamp?: string;
  model: string;
  stream: boolean;
  bodyBytes: number;
  messageCount: number;
  messageBytesByRole: Record<string, number>;
  systemBytes: number;
  toolsCount: number;
  toolSchemaBytes: number;
  topLevelKeys: string[];
}

export interface RuntimeToolDiagnostics {
  toolUseCount: number;
  toolResultCount: number;
  toolResultErrorCount: number;
  totalToolUseArgBytes: number;
  maxToolUseArgBytes: number;
  totalToolResultBytes: number;
  maxToolResultBytes: number;
  byName: Record<string, RuntimeToolNameDiagnostics>;
}

export interface RuntimeToolNameDiagnostics {
  uses: number;
  argBytes: number;
  maxArgBytes: number;
  results: number;
  errors: number;
  resultBytes: number;
  maxResultBytes: number;
}

export interface RuntimeToolResultRecord {
  name: string;
  callId: string;
  resultBytes: number;
  isError: boolean;
}

export interface RuntimeDiagnosticsCollectorOptions {
  enabled?: boolean;
  now?: () => string;
}

const RUNTIME_PROFILE_ENV = 'QWEN_CODE_PROFILE_RUNTIME';

export function isRuntimeDiagnosticsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[RUNTIME_PROFILE_ENV] === '1';
}

export class RuntimeDiagnosticsCollector {
  private enabled: boolean;
  private readonly now: () => string;
  private startedAt: string;
  private requestIndex = 0;
  private openAIWireRequestIndex = 0;
  private anthropicWireRequestIndex = 0;
  private requests: GenerateContentRequestDiagnostics[] = [];
  private openaiWireRequests: OpenAIWireRequestDiagnostics[] = [];
  private anthropicWireRequests: AnthropicWireRequestDiagnostics[] = [];
  private tools: RuntimeToolDiagnostics = createInitialToolDiagnostics();

  constructor(options: RuntimeDiagnosticsCollectorOptions = {}) {
    this.enabled = options.enabled ?? isRuntimeDiagnosticsEnabled();
    this.now = options.now ?? (() => new Date().toISOString());
    this.startedAt = this.now();
  }

  reset(options: { enabled?: boolean } = {}): void {
    this.enabled = options.enabled ?? isRuntimeDiagnosticsEnabled();
    this.startedAt = this.now();
    this.requestIndex = 0;
    this.openAIWireRequestIndex = 0;
    this.anthropicWireRequestIndex = 0;
    this.requests = [];
    this.openaiWireRequests = [];
    this.anthropicWireRequests = [];
    this.tools = createInitialToolDiagnostics();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordGenerateContentRequest(
    request: GenerateContentParameters,
    options: {
      stream: boolean;
      source: 'generateContent' | 'generateContentStream';
    },
  ): void {
    if (!this.enabled) {
      return;
    }

    this.requestIndex += 1;
    this.requests.push({
      index: this.requestIndex,
      timestamp: this.now(),
      source: options.source,
      model: request.model,
      stream: options.stream,
      serializedBytes: utf8Bytes(toJsonSafeRequest(request)),
      contents: summarizeContents(request.contents),
      systemInstructionBytes: summarizeContentTextBytes(
        request.config?.systemInstruction,
      ),
      generationConfigBytes: utf8Bytes(toJsonSafeConfig(request.config)),
      tools: summarizeToolSchemas(request.config?.tools),
    });
  }

  recordOpenAIWireRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
  ): void {
    if (!this.enabled) {
      return;
    }

    this.openAIWireRequestIndex += 1;
    this.openaiWireRequests.push({
      index: this.openAIWireRequestIndex,
      timestamp: this.now(),
      ...summarizeOpenAIWireRequest(request),
    });
  }

  recordAnthropicWireRequest(
    request:
      | Anthropic.MessageCreateParamsNonStreaming
      | Anthropic.MessageCreateParamsStreaming,
  ): void {
    if (!this.enabled) {
      return;
    }

    this.anthropicWireRequestIndex += 1;
    this.anthropicWireRequests.push({
      index: this.anthropicWireRequestIndex,
      timestamp: this.now(),
      ...summarizeAnthropicWireRequest(request),
    });
  }

  recordToolUse(name: string, args: unknown): void {
    if (!this.enabled) {
      return;
    }

    const argBytes = utf8Bytes(args);
    const tool = this.getToolNameDiagnostics(name);
    tool.uses += 1;
    tool.argBytes += argBytes;
    tool.maxArgBytes = Math.max(tool.maxArgBytes, argBytes);
    this.tools.toolUseCount += 1;
    this.tools.totalToolUseArgBytes += argBytes;
    this.tools.maxToolUseArgBytes = Math.max(
      this.tools.maxToolUseArgBytes,
      argBytes,
    );
  }

  recordToolResult(record: RuntimeToolResultRecord): void {
    if (!this.enabled) {
      return;
    }

    const tool = this.getToolNameDiagnostics(record.name);
    tool.results += 1;
    tool.resultBytes += record.resultBytes;
    tool.maxResultBytes = Math.max(tool.maxResultBytes, record.resultBytes);
    if (record.isError) {
      tool.errors += 1;
      this.tools.toolResultErrorCount += 1;
    }
    this.tools.toolResultCount += 1;
    this.tools.totalToolResultBytes += record.resultBytes;
    this.tools.maxToolResultBytes = Math.max(
      this.tools.maxToolResultBytes,
      record.resultBytes,
    );
  }

  snapshot(): RuntimeDiagnosticsSnapshot {
    return {
      enabled: this.enabled,
      startedAt: this.startedAt,
      requests: this.requests.map((request) => ({
        ...request,
        contents: {
          ...request.contents,
          roleCounts: { ...request.contents.roleCounts },
        },
        tools: { ...request.tools },
      })),
      openaiWireRequests: this.openaiWireRequests.map((request) => ({
        ...request,
        messageBytesByRole: { ...request.messageBytesByRole },
        topLevelKeys: [...request.topLevelKeys],
      })),
      anthropicWireRequests: this.anthropicWireRequests.map((request) => ({
        ...request,
        messageBytesByRole: { ...request.messageBytesByRole },
        topLevelKeys: [...request.topLevelKeys],
      })),
      tools: {
        ...this.tools,
        byName: Object.fromEntries(
          Object.entries(this.tools.byName).map(([name, value]) => [
            name,
            { ...value },
          ]),
        ),
      },
    };
  }

  private getToolNameDiagnostics(name: string): RuntimeToolNameDiagnostics {
    const existing = this.tools.byName[name];
    if (existing) {
      return existing;
    }
    const created = createInitialToolNameDiagnostics();
    this.tools.byName[name] = created;
    return created;
  }
}

export const runtimeDiagnostics = new RuntimeDiagnosticsCollector();

export function summarizeOpenAIWireRequest(
  request: OpenAI.Chat.ChatCompletionCreateParams,
): OpenAIWireRequestDiagnostics {
  const requestRecord = asRecord(request);
  const messages = Array.isArray(requestRecord['messages'])
    ? requestRecord['messages']
    : [];
  const tools = Array.isArray(requestRecord['tools'])
    ? requestRecord['tools']
    : [];
  const messageBytesByRole: Record<string, number> = {};
  for (const message of messages) {
    const messageRecord = asRecord(message);
    const role =
      typeof messageRecord['role'] === 'string'
        ? messageRecord['role']
        : 'unknown';
    messageBytesByRole[role] =
      (messageBytesByRole[role] ?? 0) + utf8Bytes(messageRecord['content']);
  }

  return {
    model:
      typeof requestRecord['model'] === 'string'
        ? requestRecord['model']
        : 'unknown',
    stream: requestRecord['stream'] === true,
    bodyBytes: utf8Bytes(request),
    messageCount: messages.length,
    messageBytesByRole,
    toolsCount: tools.length,
    toolSchemaBytes: utf8Bytes(tools),
    topLevelKeys: Object.keys(requestRecord).sort(),
  };
}

export function summarizeAnthropicWireRequest(
  request:
    | Anthropic.MessageCreateParamsNonStreaming
    | Anthropic.MessageCreateParamsStreaming,
): AnthropicWireRequestDiagnostics {
  const requestRecord = asRecord(request);
  const messages = Array.isArray(requestRecord['messages'])
    ? requestRecord['messages']
    : [];
  const tools = Array.isArray(requestRecord['tools'])
    ? requestRecord['tools']
    : [];
  const messageBytesByRole: Record<string, number> = {};
  for (const message of messages) {
    const messageRecord = asRecord(message);
    const role =
      typeof messageRecord['role'] === 'string'
        ? messageRecord['role']
        : 'unknown';
    messageBytesByRole[role] =
      (messageBytesByRole[role] ?? 0) + utf8Bytes(messageRecord['content']);
  }

  return {
    model:
      typeof requestRecord['model'] === 'string'
        ? requestRecord['model']
        : 'unknown',
    stream: requestRecord['stream'] === true,
    bodyBytes: utf8Bytes(request),
    messageCount: messages.length,
    messageBytesByRole,
    systemBytes: utf8Bytes(requestRecord['system']),
    toolsCount: tools.length,
    toolSchemaBytes: utf8Bytes(tools),
    topLevelKeys: Object.keys(requestRecord).sort(),
  };
}

function createInitialToolDiagnostics(): RuntimeToolDiagnostics {
  return {
    toolUseCount: 0,
    toolResultCount: 0,
    toolResultErrorCount: 0,
    totalToolUseArgBytes: 0,
    maxToolUseArgBytes: 0,
    totalToolResultBytes: 0,
    maxToolResultBytes: 0,
    byName: Object.create(null) as Record<string, RuntimeToolNameDiagnostics>,
  };
}

function createInitialToolNameDiagnostics(): RuntimeToolNameDiagnostics {
  return {
    uses: 0,
    argBytes: 0,
    maxArgBytes: 0,
    results: 0,
    errors: 0,
    resultBytes: 0,
    maxResultBytes: 0,
  };
}

function summarizeContents(contents: unknown): RuntimeContentDiagnostics {
  const summary: RuntimeContentDiagnostics = {
    count: 0,
    roleCounts: {},
    partCount: 0,
    textBytes: 0,
    functionCallCount: 0,
    functionCallArgBytes: 0,
    functionResponseCount: 0,
    functionResponseBytes: 0,
    inlineDataCount: 0,
    inlineDataBytes: 0,
    fileDataCount: 0,
  };
  const contentItems = Array.isArray(contents)
    ? contents
    : contents === undefined || contents === null
      ? []
      : [contents];

  for (const content of contentItems) {
    summary.count += 1;
    if (typeof content === 'string') {
      summary.roleCounts['user'] = (summary.roleCounts['user'] ?? 0) + 1;
      summary.partCount += 1;
      summary.textBytes += utf8Bytes(content);
      continue;
    }

    const contentRecord = asRecord(content);
    const role =
      typeof contentRecord['role'] === 'string'
        ? contentRecord['role']
        : 'unknown';
    summary.roleCounts[role] = (summary.roleCounts[role] ?? 0) + 1;
    const parts = Array.isArray(contentRecord['parts'])
      ? contentRecord['parts']
      : [];
    summarizeParts(parts, summary);
  }

  return summary;
}

function summarizeContentTextBytes(content: unknown): number {
  const summary = summarizeContents(content);
  return summary.textBytes;
}

function summarizeParts(
  parts: unknown[],
  summary: RuntimeContentDiagnostics,
): void {
  for (const part of parts) {
    summary.partCount += 1;
    if (typeof part === 'string') {
      summary.textBytes += utf8Bytes(part);
      continue;
    }
    const partRecord = asRecord(part);
    if (typeof partRecord['text'] === 'string') {
      summary.textBytes += utf8Bytes(partRecord['text']);
    }
    const functionCall = asOptionalRecord(partRecord['functionCall']);
    if (functionCall) {
      summary.functionCallCount += 1;
      summary.functionCallArgBytes += utf8Bytes(functionCall['args']);
    }
    const functionResponse = asOptionalRecord(partRecord['functionResponse']);
    if (functionResponse) {
      summary.functionResponseCount += 1;
      summary.functionResponseBytes +=
        utf8Bytes(functionResponse['response']) +
        utf8Bytes(functionResponse['parts']);
    }
    const inlineData = asOptionalRecord(partRecord['inlineData']);
    if (inlineData) {
      summary.inlineDataCount += 1;
      summary.inlineDataBytes += utf8Bytes(inlineData['data']);
    }
    if (partRecord['fileData']) {
      summary.fileDataCount += 1;
    }
  }
}

function summarizeToolSchemas(tools: unknown): RuntimeToolSchemaDiagnostics {
  const toolList = Array.isArray(tools) ? tools : [];
  let functionDeclarationCount = 0;
  for (const tool of toolList) {
    const toolRecord = asRecord(tool);
    const declarations = Array.isArray(toolRecord['functionDeclarations'])
      ? toolRecord['functionDeclarations']
      : [];
    functionDeclarationCount += declarations.length;
  }
  return {
    count: toolList.length,
    functionDeclarationCount,
    schemaBytes: utf8Bytes(toolList),
  };
}

function toJsonSafeRequest(request: GenerateContentParameters): unknown {
  return {
    model: request.model,
    contents: request.contents,
    config: toJsonSafeConfig(request.config),
  };
}

function toJsonSafeConfig(
  config: GenerateContentParameters['config'],
): unknown {
  if (!config) {
    return undefined;
  }
  const configRecord = asRecord(config);
  const safeConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(configRecord)) {
    if (key === 'abortSignal') {
      continue;
    }
    safeConfig[key] = value;
  }
  return safeConfig;
}

function utf8Bytes(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8');
  }
  return Buffer.byteLength(safeStringify(value), 'utf8');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
