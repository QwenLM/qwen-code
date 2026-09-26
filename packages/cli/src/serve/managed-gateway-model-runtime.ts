/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import type {
  Content,
  FunctionCall,
  FunctionDeclaration,
  Part,
} from '@google/genai';
import type {
  BridgeManagedRuntimeToolExecuteRequest,
  BridgeManagedRuntimeToolExecuteResult,
  BridgeManagedRuntimeToolManifest,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { convertToFunctionErrorResponse } from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import { canonicalToolName } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import { CONCURRENCY_SAFE_KINDS } from '@qwen-code/qwen-code-core/tools/tools.js';
import { getFunctionCalls } from '@qwen-code/qwen-code-core/utils/generateContentResponseUtilities.js';
import { getResponseText } from '@qwen-code/qwen-code-core/utils/partUtils.js';
import { getThoughtSummary } from '@qwen-code/qwen-code-core/utils/thoughtUtils.js';
import type { BridgePromptContentBlock } from './acp-session-bridge.js';
import { FileManagedGatewayConversationStore } from './managed-gateway-conversation-store.js';
import type { ManagedGatewayPromptRequest } from './managed-prompt-types.js';

export interface ManagedGatewayAgentSink {
  readonly onModelStarted: (model: {
    round: number;
    agentDefinitionId: string;
  }) => void | Promise<void>;
  readonly onThought: (text: string) => void | Promise<void>;
  readonly onDelta: (text: string) => void | Promise<void>;
  readonly onToolRequested: (call: {
    toolCallId: string;
    toolName: string;
  }) => void | Promise<void>;
  readonly onToolStarted?: (call: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => void | Promise<void>;
  readonly onToolCompleted: (result: {
    toolCallId: string;
    toolName: string;
    failed: boolean;
    output?: unknown;
  }) => void | Promise<void>;
}

export interface ManagedGatewayToolRuntime {
  getManifest(signal: AbortSignal): Promise<BridgeManagedRuntimeToolManifest>;
  execute(
    request: BridgeManagedRuntimeToolExecuteRequest,
    signal: AbortSignal,
  ): Promise<BridgeManagedRuntimeToolExecuteResult>;
}

interface ManagedGatewayAgentDefinition {
  readonly id: string;
  readonly tools: readonly FunctionDeclaration[];
}

interface ValidatedManagedRuntimeToolManifest {
  readonly capabilityDigest: string;
  readonly tools: FunctionDeclaration[];
}

export interface ManagedGatewayModelRunner {
  start(): Promise<void>;
  runTurn(
    request: ManagedGatewayPromptRequest,
    runtime: ManagedGatewayToolRuntime,
    sink: ManagedGatewayAgentSink,
    signal: AbortSignal,
  ): Promise<string>;
  dispose(): Promise<void>;
}

const AGENT_SYSTEM_INSTRUCTION = `You are the authoritative resident model loop of a managed coding agent.
The function declarations attached to the request execute inside the user's isolated local Runtime. Use them when local evidence is needed.
Never claim that you read, searched, fetched, or inspected local data unless a Tool result in this conversation proves it.
The current prototype exposes read-only local capabilities. Do not promise file mutations or shell execution.
Answer in the user's language. Produce a complete final answer after using any needed tools.`;

const MAX_TOOL_ROUNDS = 16;
const MAX_TOOL_CALLS = 32;
const MAX_RUNTIME_TOOLS = 256;
const MAX_RUNTIME_MANIFEST_BYTES = 1024 * 1024;
const MAX_RUNTIME_TOOL_RESULT_BYTES = 8 * 1024 * 1024;

function jsonClone<T>(value: T, message: string): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw new Error(message);
  }
}

function createAgentDefinition(config: Config): ManagedGatewayAgentDefinition {
  const registry = config.getToolRegistry();
  const tools = registry.getFunctionDeclarations().filter((declaration) => {
    const name = declaration.name;
    if (!name) return false;
    const tool = registry.getTool(canonicalToolName(name));
    return tool !== undefined && CONCURRENCY_SAFE_KINDS.has(tool.kind);
  });
  const normalizedTools = jsonClone(
    tools,
    'Managed Gateway Agent Definition is not JSON serializable.',
  );
  const serialized = JSON.stringify({ version: 1, tools: normalizedTools });
  if (
    normalizedTools.length > MAX_RUNTIME_TOOLS ||
    Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_MANIFEST_BYTES
  ) {
    throw new Error('Managed Gateway Agent Definition exceeds its bounds.');
  }
  const names = new Set<string>();
  for (const declaration of normalizedTools) {
    if (
      !declaration.name ||
      declaration.name.length > 256 ||
      names.has(declaration.name)
    ) {
      throw new Error('Managed Gateway Agent Definition is invalid.');
    }
    names.add(declaration.name);
  }
  const capabilityDigest = createHash('sha256')
    .update(serialized)
    .digest('hex');
  return {
    id: `qwen-managed-readonly-v1:${capabilityDigest}`,
    tools: normalizedTools,
  };
}

function executableDeclaration(declaration: FunctionDeclaration): unknown {
  const normalized = jsonClone(
    declaration,
    'Managed Runtime returned an invalid Tool declaration.',
  ) as FunctionDeclaration & Record<string, unknown>;
  delete normalized.description;
  return normalized;
}

function assertRuntimeCompatibility(
  definition: ManagedGatewayAgentDefinition,
  manifest: ValidatedManagedRuntimeToolManifest,
  toolName: string,
): void {
  const expected = definition.tools.find((tool) => tool.name === toolName);
  const actual = manifest.tools.find((tool) => tool.name === toolName);
  if (
    !expected ||
    !actual ||
    !isDeepStrictEqual(
      executableDeclaration(expected),
      executableDeclaration(actual),
    )
  ) {
    throw new Error(
      `Managed Runtime Tool '${toolName}' is incompatible with Agent Definition '${definition.id}'.`,
    );
  }
}

function toModelParts(prompt: readonly BridgePromptContentBlock[]): Part[] {
  return prompt.map((block): Part => {
    if (block.type === 'text') return { text: block.text };
    if (
      block.type === 'image' &&
      'data' in block &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    ) {
      return {
        inlineData: { data: block.data, mimeType: block.mimeType },
      };
    }
    throw new Error(
      'Managed Gateway supports text and inline raster images only.',
    );
  });
}

function thoughtText(part: ReturnType<typeof getThoughtSummary>): string {
  if (!part) return '';
  return part.subject
    ? `${part.subject}\n${part.description}`
    : part.description;
}

function validatedManifest(
  manifest: unknown,
): ValidatedManagedRuntimeToolManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Managed Runtime returned an invalid Tool manifest.');
  }
  const candidate = manifest as Record<string, unknown>;
  const capabilityDigest = candidate['capabilityDigest'];
  const tools = candidate['tools'];
  let serialized: string;
  try {
    serialized = JSON.stringify(manifest);
  } catch {
    throw new Error('Managed Runtime returned an invalid Tool manifest.');
  }
  if (
    typeof capabilityDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(capabilityDigest) ||
    !Array.isArray(tools) ||
    tools.length > MAX_RUNTIME_TOOLS ||
    Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_MANIFEST_BYTES ||
    createHash('sha256').update(JSON.stringify(tools)).digest('hex') !==
      capabilityDigest
  ) {
    throw new Error('Managed Runtime returned an invalid Tool manifest.');
  }
  const names = new Set<string>();
  for (const declaration of tools) {
    if (
      !declaration ||
      typeof declaration !== 'object' ||
      typeof declaration.name !== 'string' ||
      declaration.name.length === 0 ||
      declaration.name.length > 256 ||
      names.has(declaration.name)
    ) {
      throw new Error('Managed Runtime returned an invalid Tool manifest.');
    }
    names.add(declaration.name);
  }
  return JSON.parse(serialized) as ValidatedManagedRuntimeToolManifest;
}

function validatedResponseParts(
  result: unknown,
  toolCallId: string,
  toolName: string,
): Part[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Managed Runtime returned an invalid Tool result.');
  }
  const responseParts = (result as Record<string, unknown>)['responseParts'];
  let serialized: string;
  try {
    serialized = JSON.stringify(responseParts);
  } catch {
    throw new Error('Managed Runtime returned an invalid Tool result.');
  }
  if (
    !Array.isArray(responseParts) ||
    responseParts.length !== 1 ||
    Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_TOOL_RESULT_BYTES
  ) {
    throw new Error('Managed Runtime returned an invalid Tool result.');
  }
  const responses = responseParts.filter(
    (
      part,
    ): part is Part & {
      functionResponse: NonNullable<Part['functionResponse']>;
    } =>
      Boolean(
        part &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          part.functionResponse,
      ),
  );
  const response = responses[0]?.functionResponse;
  if (
    response?.id !== toolCallId ||
    response.name !== toolName ||
    !response.response ||
    typeof response.response !== 'object' ||
    Array.isArray(response.response)
  ) {
    throw new Error('Managed Runtime returned a mismatched Tool result.');
  }
  return JSON.parse(serialized) as Part[];
}

function normalizedCalls(
  calls: readonly FunctionCall[],
  thoughtSignatures: ReadonlyArray<string | undefined>,
  request: ManagedGatewayPromptRequest,
  round: number,
): Array<{
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}> {
  const ids = new Set<string>();
  return calls.map((call, index) => {
    if (!call.name || typeof call.name !== 'string') {
      throw new Error(
        'Managed Gateway model returned a Tool Call without a name.',
      );
    }
    const id =
      typeof call.id === 'string' && call.id.length > 0
        ? call.id
        : `${request.messageId}:${round}:${index}`;
    if (ids.has(id)) {
      throw new Error(
        `Managed Gateway model reused Tool Call id '${id}' in one round.`,
      );
    }
    ids.add(id);
    const args = call.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(
        `Managed Gateway model returned invalid arguments for '${call.name}'.`,
      );
    }
    const thoughtSignature = thoughtSignatures[index];
    return {
      id,
      name: call.name,
      args: structuredClone(args),
      ...(thoughtSignature ? { thoughtSignature } : {}),
    };
  });
}

function modelContent(
  streamedParts: readonly Part[],
  calls: ReturnType<typeof normalizedCalls>,
): Content {
  const parts: Part[] = [];
  const thoughtParts = streamedParts.filter((part) => part.thought);
  const thoughtText = thoughtParts
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  if (thoughtText) {
    const thoughtSignature = thoughtParts.find(
      (part) => part.thoughtSignature,
    )?.thoughtSignature;
    parts.push({
      text: thoughtText,
      thought: true,
      ...(thoughtSignature ? { thoughtSignature } : {}),
    });
  }
  for (const streamedPart of streamedParts) {
    if (streamedPart.thought || streamedPart.functionCall) continue;
    const previous = parts.at(-1);
    if (
      typeof streamedPart.text === 'string' &&
      !streamedPart.thoughtSignature &&
      previous &&
      typeof previous.text === 'string' &&
      !previous.thought &&
      !previous.thoughtSignature &&
      !previous.functionCall &&
      !previous.functionResponse &&
      !previous.inlineData &&
      !previous.fileData
    ) {
      previous.text += streamedPart.text;
    } else {
      parts.push(structuredClone(streamedPart));
    }
  }
  parts.push(
    ...calls.map((call) => ({
      functionCall: { id: call.id, name: call.name, args: call.args },
      ...(call.thoughtSignature
        ? { thoughtSignature: call.thoughtSignature }
        : {}),
    })),
  );
  return { role: 'model', parts };
}

export class ResidentManagedGatewayModelRunner
  implements ManagedGatewayModelRunner
{
  private configPromise: Promise<Config> | undefined;
  private config: Config | undefined;
  private conversationStorePromise:
    | Promise<FileManagedGatewayConversationStore>
    | undefined;
  private agentDefinitionPromise:
    | Promise<ManagedGatewayAgentDefinition>
    | undefined;
  private disposed = false;
  private readonly baseEnvironment: Readonly<NodeJS.ProcessEnv>;

  constructor(
    private readonly gatewayWorkspace: string,
    private readonly stateDir: string,
    baseEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
  ) {
    this.baseEnvironment = Object.freeze({ ...baseEnvironment });
  }

  async start(): Promise<void> {
    await Promise.all([
      this.getConfig(),
      this.getConversationStore(),
      this.getAgentDefinition(),
    ]);
  }

  async runTurn(
    request: ManagedGatewayPromptRequest,
    runtime: ManagedGatewayToolRuntime,
    sink: ManagedGatewayAgentSink,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const [config, store, agentDefinition] = await Promise.all([
      this.getConfig(),
      this.getConversationStore(),
      this.getAgentDefinition(),
    ]);
    signal.throwIfAborted();
    const existing = store.get(request.sessionId);
    const bootstrap = request.turnKind === 'bootstrap';
    if (bootstrap && existing) {
      throw new Error(
        'Managed Gateway initial turn already has conversation history.',
      );
    }
    if (!bootstrap && !existing) {
      throw new Error(
        'Managed Gateway continuation has no durable conversation history.',
      );
    }
    if (existing?.messageId === request.messageId) {
      throw new Error('Managed Gateway turn was already committed.');
    }

    const history: Content[] = existing
      ? structuredClone([...existing.history])
      : [];
    history.push({ role: 'user', parts: toModelParts(request.prompt) });
    let totalToolCalls = 0;
    const toolCallIds = new Set<string>();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      signal.throwIfAborted();
      await sink.onModelStarted({
        round,
        agentDefinitionId: agentDefinition.id,
      });
      const stream = await config.getContentGenerator().generateContentStream(
        {
          model: config.getModel(),
          contents: history,
          config: {
            abortSignal: signal,
            tools:
              agentDefinition.tools.length === 0
                ? []
                : [{ functionDeclarations: [...agentDefinition.tools] }],
            maxOutputTokens: 4096,
            systemInstruction: AGENT_SYSTEM_INSTRUCTION,
          },
        },
        `managed-agent:${request.sessionId}:${request.messageId}:${round}`,
      );
      let text = '';
      const rawCalls: FunctionCall[] = [];
      const rawCallThoughtSignatures: Array<string | undefined> = [];
      const streamedParts: Part[] = [];
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const thought = thoughtText(getThoughtSummary(chunk));
        if (thought) await sink.onThought(thought);
        const delta = getResponseText(chunk) ?? '';
        if (delta) {
          text += delta;
          await sink.onDelta(delta);
        }
        const chunkCalls = getFunctionCalls(chunk) ?? [];
        const chunkCallParts =
          chunk.candidates?.[0]?.content?.parts?.filter(
            (part) => part.functionCall,
          ) ?? [];
        rawCalls.push(...chunkCalls);
        rawCallThoughtSignatures.push(
          ...chunkCalls.map(
            (_, index) =>
              chunkCallParts[index]?.thoughtSignature ??
              (chunkCalls.length === 1
                ? chunkCallParts.find((part) => part.thoughtSignature)
                    ?.thoughtSignature
                : undefined),
          ),
        );
        streamedParts.push(
          ...structuredClone(
            chunk.candidates?.[0]?.content?.parts?.filter(
              (part) => !part.functionCall,
            ) ?? [],
          ),
        );
      }
      signal.throwIfAborted();
      const calls = normalizedCalls(
        rawCalls,
        rawCallThoughtSignatures,
        request,
        round,
      );
      for (const call of calls) {
        if (toolCallIds.has(call.id)) {
          throw new Error(
            `Managed Gateway model reused Tool Call id '${call.id}' across rounds.`,
          );
        }
        toolCallIds.add(call.id);
      }
      history.push(modelContent(streamedParts, calls));
      if (calls.length === 0) {
        const answer = text.trim();
        if (!answer) {
          throw new Error('Managed Gateway model returned no final answer.');
        }
        await store.commit(request.sessionId, request.messageId, history);
        return answer;
      }
      totalToolCalls += calls.length;
      if (totalToolCalls > MAX_TOOL_CALLS) {
        throw new Error(
          `Managed Gateway exceeded the ${MAX_TOOL_CALLS} Tool Call limit.`,
        );
      }

      const responseParts: Part[] = [];
      let runtimeManifest: ValidatedManagedRuntimeToolManifest | undefined;
      for (const call of calls) {
        signal.throwIfAborted();
        await sink.onToolRequested({
          toolCallId: call.id,
          toolName: call.name,
        });
        const declared = agentDefinition.tools.some(
          (declaration) => declaration.name === call.name,
        );
        if (!declared) {
          responseParts.push(
            ...convertToFunctionErrorResponse(
              call.name,
              call.id,
              `Tool '${call.name}' is not available in this Runtime capability set.`,
              'Tool is unavailable.',
            ),
          );
          await sink.onToolCompleted({
            toolCallId: call.id,
            toolName: call.name,
            failed: true,
          });
          continue;
        }
        runtimeManifest ??= validatedManifest(
          await runtime.getManifest(signal),
        );
        assertRuntimeCompatibility(agentDefinition, runtimeManifest, call.name);
        await sink.onToolStarted?.({
          toolCallId: call.id,
          toolName: call.name,
          input: call.args,
        });
        signal.throwIfAborted();
        const result = await runtime.execute(
          {
            executionId: randomUUID(),
            turnId: request.messageId,
            toolCallId: call.id,
            capabilityDigest: runtimeManifest.capabilityDigest,
            toolName: call.name,
            input: call.args,
          },
          signal,
        );
        responseParts.push(
          ...validatedResponseParts(result, call.id, call.name),
        );
        await sink.onToolCompleted({
          toolCallId: call.id,
          toolName: call.name,
          output:
            result.error ?? validatedResponseParts(result, call.id, call.name),
          failed:
            result.error !== undefined ||
            (result.executionStatus !== undefined &&
              result.executionStatus !== 'success'),
        });
      }
      history.push({ role: 'user', parts: responseParts });
    }

    throw new Error(
      `Managed Gateway exceeded the ${MAX_TOOL_ROUNDS} Tool round limit.`,
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const config =
      this.config ?? (await this.configPromise?.catch(() => undefined));
    await config?.shutdown();
    this.config = undefined;
  }

  private getConversationStore(): Promise<FileManagedGatewayConversationStore> {
    if (this.disposed) {
      return Promise.reject(new Error('Managed Gateway model is disposed.'));
    }
    this.conversationStorePromise ??= FileManagedGatewayConversationStore.open(
      `${this.stateDir}/conversations.jsonl`,
    );
    return this.conversationStorePromise;
  }

  private getAgentDefinition(): Promise<ManagedGatewayAgentDefinition> {
    if (this.disposed) {
      return Promise.reject(new Error('Managed Gateway model is disposed.'));
    }
    this.agentDefinitionPromise ??= this.getConfig().then((config) =>
      createAgentDefinition(config),
    );
    return this.agentDefinitionPromise;
  }

  private getConfig(): Promise<Config> {
    if (this.disposed) {
      return Promise.reject(new Error('Managed Gateway model is disposed.'));
    }
    this.configPromise ??= this.initializeConfig();
    return this.configPromise;
  }

  private async initializeConfig(): Promise<Config> {
    const [
      { loadSettings },
      { loadCliConfig },
      { buildRuntimeEnvironment, buildHostBootstrapEnvironment },
    ] = await Promise.all([
      import('../config/settings.js'),
      import('../config/config.js'),
      import('../config/environment.js'),
    ]);
    const hostEnvironment = buildHostBootstrapEnvironment(this.baseEnvironment);
    const settingsOptions = {
      consumeCorruptionEnvVars: false,
      skipWorkspaceSettings: true,
      workspaceTrusted: false,
      runtimeEnvironment: hostEnvironment,
    };
    const initialSettings = loadSettings(
      this.gatewayWorkspace,
      settingsOptions,
    );
    const homeEnvironment = buildRuntimeEnvironment(
      { ...initialSettings.merged, env: undefined },
      homedir(),
      hostEnvironment,
      false,
    );
    if (homeEnvironment.envFileReadFailed) {
      throw new Error('Managed Gateway could not read its host environment.');
    }
    const homeSettings = loadSettings(this.gatewayWorkspace, {
      ...settingsOptions,
      runtimeEnvironment: homeEnvironment.effectiveEnv,
    });
    const snapshot = buildRuntimeEnvironment(
      homeSettings.merged,
      homedir(),
      hostEnvironment,
      false,
    );
    if (snapshot.envFileReadFailed) {
      throw new Error('Managed Gateway could not read its host environment.');
    }
    const settings = loadSettings(this.gatewayWorkspace, {
      ...settingsOptions,
      runtimeEnvironment: snapshot.effectiveEnv,
    });
    const config = await loadCliConfig(
      settings.merged,
      {
        query: undefined,
        model: undefined,
        fallbackModel: undefined,
        sandbox: undefined,
        sandboxImage: undefined,
        debug: undefined,
        prompt: undefined,
        promptInteractive: undefined,
        systemPrompt: undefined,
        appendSystemPrompt: undefined,
        yolo: undefined,
        bare: false,
        safeMode: true,
        approvalMode: 'plan',
        telemetry: undefined,
        telemetryTarget: undefined,
        telemetryOtlpEndpoint: undefined,
        telemetryOtlpProtocol: undefined,
        telemetryLogPrompts: undefined,
        telemetryOutfile: undefined,
        allowedMcpServerNames: undefined,
        mcpConfig: undefined,
        allowedTools: undefined,
        acp: undefined,
        experimentalAcp: undefined,
        experimentalLsp: false,
        restoreAskUserQuestion: false,
        extensions: [],
        listExtensions: undefined,
        openaiLogging: undefined,
        openaiApiKey: undefined,
        openaiBaseUrl: undefined,
        openaiLoggingDir: undefined,
        proxy: undefined,
        includeDirectories: [],
        screenReader: undefined,
        inputFormat: 'text',
        outputFormat: 'text',
        outputStyle: undefined,
        includePartialMessages: false,
        chatRecording: false,
        continue: undefined,
        resume: undefined,
        sessionId: randomUUID(),
        sessionIdGenerated: true,
        forkSession: undefined,
        maxSessionTurns: undefined,
        maxWallTime: undefined,
        maxToolCalls: undefined,
        maxSubagentDepth: undefined,
        coreTools: undefined,
        excludeTools: undefined,
        disabledSlashCommands: undefined,
        authType: undefined,
        channel: undefined,
        jsonFd: undefined,
        jsonFile: undefined,
        jsonSchema: undefined,
        inputFile: undefined,
      },
      this.gatewayWorkspace,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      {
        runtimeEnvironment: snapshot.effectiveEnv,
        processNetworkOwner: true,
      },
    );
    const authType = config.getModelsConfig().getCurrentAuthType();
    if (!authType) {
      await config.shutdown();
      throw new Error(
        'Managed Gateway model has no configured authentication provider.',
      );
    }
    try {
      await config.refreshAuth(authType, true);
      await config.initialize({
        skipMcpDiscovery: true,
        skipHooks: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
        lenientToolWarmup: true,
      });
      config.setReasoningEffort('low');
    } catch (error) {
      await config.shutdown();
      throw error;
    }
    if (this.disposed) {
      await config.shutdown();
      throw new Error('Managed Gateway model was disposed during startup.');
    }
    this.config = config;
    return config;
  }
}
