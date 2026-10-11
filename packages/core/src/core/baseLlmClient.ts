/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
  EmbedContentParameters,
  FunctionDeclaration,
  Tool,
  Schema,
} from '@google/genai';
import { FunctionCallingConfigMode } from './genai-compat.js';
import type { Config } from '../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
  PromptCacheSharingParameters,
} from './contentGenerator.js';
import { AuthType, createContentGenerator } from './contentGenerator.js';
import type { ResolvedModelConfig } from '../models/types.js';
import { buildAgentContentGeneratorConfig } from '../models/content-generator-config.js';
import {
  buildModelIdContext,
  resolveModelId,
  type ResolvedModelId,
} from '../utils/modelId.js';
import { reportError } from '../utils/errorReporting.js';
import { getErrorMessage } from '../utils/errors.js';
import { retryWithBackoff, isUnattendedMode } from '../utils/retry.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import { ApiRetryEvent } from '../telemetry/types.js';
import { logApiRetry } from '../telemetry/loggers.js';
import { getFunctionCalls } from '../utils/generateContentResponseUtilities.js';
import { getResponseText } from '../utils/partUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';
import {
  resolveSlimmingConfig,
  slimCompactionInput,
} from '../services/compactionInputSlimming.js';
import {
  CHARS_PER_TOKEN,
  estimateContentTokens,
} from '../services/tokenEstimation.js';
import {
  defaultOutputCeiling,
  hasExplicitOutputLimit,
  parsePositiveIntegerEnvValue,
  tokenLimit,
} from './tokenLimits.js';

const DEFAULT_MAX_ATTEMPTS = 7;

const debugLogger = createDebugLogger('BASE_LLM_CLIENT');

function splitModelBaseUrl(model: string): { model: string; baseUrl?: string } {
  const idx = model.indexOf('\0');
  if (idx < 0) return { model };
  const modelPart = model.slice(0, idx);
  if (!modelPart) return { model: modelPart };
  return {
    model: modelPart,
    baseUrl: model.slice(idx + 1) || undefined,
  };
}

/**
 * Estimate the tokens a `systemInstruction` occupies on the wire. It travels
 * with the request but is not part of `contents`, so a room term that measures
 * only `contents` over-budgets by exactly this much (#13208). Callers pass a
 * bare string, a `Part`, a `Part[]` or a `Content`, so normalize by shape
 * before reusing the `contents` estimator.
 */
function estimateSystemInstructionTokens(
  systemInstruction: GenerateContentConfig['systemInstruction'],
): number {
  if (!systemInstruction) return 0;
  const value = systemInstruction as Content | Part | Part[] | string;
  if (typeof value === 'string') {
    return Math.ceil(value.length / CHARS_PER_TOKEN);
  }
  // Same shape-narrowing order `appendSystemInstruction` uses: a bare `Part`
  // has every field optional, so `'parts' in value` alone cannot tell it apart
  // from a `Content` — the array check on `.parts` is what decides.
  let parts: Part[];
  if (Array.isArray(value)) {
    parts = value;
  } else if (
    typeof value === 'object' &&
    'parts' in value &&
    Array.isArray(value.parts)
  ) {
    parts = value.parts;
  } else {
    parts = [value as Part];
  }
  return estimateContentTokens([{ role: 'user', parts }]);
}

/**
 * Estimate the tokens a `tools` payload occupies on the wire. `generateJson`
 * sends the `respond_in_schema` declaration whose `parameters` is the
 * caller's whole schema — an arbitrarily large object — so a room term that
 * prices only `contents` and `systemInstruction` exact-fits the window and
 * leaves zero slack for the declaration riding along on the same request,
 * which is the unretried 400 the budget exists to prevent (#13208). The wire
 * form of a declaration is JSON whichever provider format it is translated
 * to, so charge its serialized size at the same ratio as the other terms.
 */
function estimateToolTokens(tools: Tool[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
}

/**
 * Estimate the tokens a caller-supplied `responseJsonSchema` occupies on the
 * wire. `openaiContentGenerator/pipeline.ts` sends it as
 * `response_format.json_schema` beside the prompt, and `goals/goal-verifier.ts`
 * reaches the text route with one and no `maxOutputTokens` of its own — so a
 * room term that skips it exact-fits the window while the request carrying that
 * budget overshoots it by the schema's size (#13208).
 */
function estimateResponseSchemaTokens(schema: unknown): number {
  if (schema === undefined) return 0;
  return Math.ceil(JSON.stringify(schema).length / CHARS_PER_TOKEN);
}

/**
 * Give a request an output budget that fits the window it is actually going
 * to, so `prompt + max_tokens <= window` holds (#13208) for the prompt terms
 * this layer can measure: `contents`, `systemInstruction`, `tools`, and a
 * caller-supplied `responseJsonSchema` — in JSON mode the `respond_in_schema`
 * declaration carries the caller's whole schema and is priced by the caller
 * passing it through.
 *
 * Side queries reach the provider through `generateJson`/`generateText` and
 * never enter `llm-chat.ts`, so the main turn's `clampOutputTokensToWindow`
 * never runs on them: with no budget the wires that apply a ceiling fall back
 * to `defaultOutputCeiling(model)`, which has no window term, and a large
 * prompt overflows. That helper is deliberately not reused here either — it
 * floors at MIN_CLAMPED_OUTPUT_TOKENS (4K), a floor that can itself exceed a
 * tight window, which is exactly the invariant this path must keep. This
 * budget adds the missing window term; it is not a second output-ceiling
 * policy, and it stays out of the way when the window is not what binds.
 *
 * A caller-supplied `maxOutputTokens` passes through untouched (early return,
 * so the prompt is not even measured): compaction budgets its own against the
 * receiving window (`computeCompactionOutputBudget`, #7960) and re-clamping it
 * here would shrink it against a window it is not going to. The rest pass
 * fixed per-purpose constants — 60–4096, from `sessionTitle`,
 * `toolUseSummary`, `sessionRecap`, `permissions/classifier`,
 * `vision-bridge-service` and `LlmRewriter` — which are not window-budgeted,
 * so the invariant above is not established for those call sites.
 *
 * An explicit user ceiling — `samplingParams.max_tokens`, else
 * `QWEN_CODE_MAX_OUTPUT_TOKENS` — *replaces* `defaultOutputCeiling` as the
 * term the room is compared against instead of intersecting it. That is the
 * precedence the main turn already applies (`llm-chat.ts`
 * `explicitOutputCeiling`), the one both providers apply when the request
 * carries no output limit of its own
 * (`openaiContentGenerator/provider/default.ts` `applyOutputTokenLimit`,
 * `anthropicContentGenerator.ts` `buildSamplingParameters`), and the one
 * `docs/users/configuration/settings.md` documents ("Takes precedence over the
 * model-limit default but is overridden by `samplingParams.max_tokens`").
 * Intersecting would silently cut an operator limit set above the auto ceiling
 * — 100 000 down to 64 000, or to `DEFAULT_OUTPUT_TOKEN_LIMIT` for a
 * self-hosted id — on side queries only, and `generateText` reports no
 * `finishReason`, so the truncated page extract or recap would be stored as
 * complete. When the room is below that ceiling the emitted budget is the room
 * alone; above it nothing is emitted, so the ceiling-applying providers
 * (`openaiContentGenerator/provider/default.ts`, `anthropicContentGenerator.ts`)
 * apply the operator's value themselves as they did before, while the two wires
 * that read no ceiling stay uncapped — which is also what they did before, and
 * the point of not emitting.
 *
 * `resolvedContextWindowSize` is the window of the model the request is
 * actually sent to, resolved by `resolveForModel` against that target (its
 * registry-declared window, else the catalog/curated one). It is preferred
 * over `contentGeneratorConfig.contextWindowSize`, which on a per-model route
 * is inherited from `{ ...parentConfig }` and therefore describes the
 * *session* model whenever the target's registry entry declares no window of
 * its own — the default for a same-provider fast model, which is where side
 * queries go unless the caller pins one.
 *
 * Call after `resolveForModel` so `model` is the resolved target and
 * `contents` is the slimmed payload actually sent. Caveats:
 *
 * - On either `createRuntimeViewForModel` fallback — the target generator
 *   failed to build, or the target is not registered — the session generator
 *   sends the request, so `resolvedContextWindowSize` is `undefined` and the
 *   session config supplies the window while `model` stays the resolved
 *   target: the ceiling can then describe a different model than the window
 *   does. That mismatch is inherent to the fallback (the target's own config
 *   could not be built); the budget still never exceeds the window the request
 *   is actually handed. It can however emit nothing there while the sending
 *   wire applies its *own* fallback ceiling, which `anthropicContentGenerator`
 *   derives from the session id (`this.contentGeneratorConfig.model`) rather
 *   than the target id used here — so if that ceiling is the larger of the two
 *   and the room sits between them, the request still overflows the window
 *   exactly as it did before this budget existed. Closing that needs the
 *   receiving wire's ceiling, which this layer cannot see.
 * - For a target in neither the catalog nor the curated tables the window term
 *   falls back to `DEFAULT_TOKEN_LIMIT` (200 000) and does not bind. That
 *   fabrication is pre-existing and shared with the main turn
 *   (`tokenLimit`), not something this budget introduces.
 */
function budgetOutputTokensForWindow(
  requestConfig: GenerateContentConfig,
  contents: Content[],
  model: string,
  contentGeneratorConfig: ContentGeneratorConfig | undefined,
  resolvedContextWindowSize: number | undefined,
  imageTokenEstimate: number,
  tools?: Tool[],
): GenerateContentConfig {
  if (requestConfig.maxOutputTokens !== undefined) return requestConfig;

  // The env override is an operator ceiling, not a licence to emit above the
  // model's own output maximum. Two wires apply no output clamp of their own —
  // Gemini/Vertex, and OpenAI Responses, which assigns `max_output_tokens`
  // straight off the request — while the sibling chat wire does clamp
  // (`openaiContentGenerator/provider/default.ts` applyOutputTokenLimit, "cap at
  // model limit to avoid API errors"). On those two an over-limit budget reaches
  // the server as-is and comes back a plain 400, which `utils/retry.ts` does not
  // retry, so a side query that succeeded before it was budgeted now fails.
  // Gate on `hasExplicitOutputLimit` rather than clamping to `tokenLimit(model,
  // 'output')`: an id in neither table resolves to `DEFAULT_OUTPUT_TOKEN_LIMIT`,
  // and catalog-only limits must not clamp a user's endpoint-specific override.
  const envCeiling = parsePositiveIntegerEnvValue(
    process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'],
  );
  const explicitCeiling =
    contentGeneratorConfig?.samplingParams?.max_tokens ??
    (envCeiling === undefined
      ? undefined
      : Math.min(
          envCeiling,
          hasExplicitOutputLimit(model)
            ? tokenLimit(model, 'output')
            : Number.POSITIVE_INFINITY,
        ));
  // `<= 0` means "not configured", the reading `config.ts` gives this same
  // field: a cleared or mis-merged settings value must not become the window
  // term and cancel every governed side query's budget.
  const declaredWindow = [
    resolvedContextWindowSize,
    contentGeneratorConfig?.contextWindowSize,
  ].find((v): v is number => typeof v === 'number' && v > 0);
  const room =
    (declaredWindow ?? tokenLimit(model, 'input')) -
    // The operator's resolved estimate, not `DEFAULT_IMAGE_TOKEN_ESTIMATE`:
    // every other estimator on the send path uses it, and pricing a kept image
    // low here over-states the room, which is the 400 this budget exists to
    // prevent.
    estimateContentTokens(contents, imageTokenEstimate) -
    estimateSystemInstructionTokens(requestConfig.systemInstruction) -
    estimateToolTokens(tools) -
    estimateResponseSchemaTokens(requestConfig.responseJsonSchema);

  // A window the measured prompt all but fills is not this layer's to paper
  // over: `max_tokens: 12` would send a request that can only answer with a
  // stub and report it as a normal success — `generateText` returns no
  // `finishReason`, so `tools/web-fetch.ts` would store that body as the page
  // extract. Leave it uncapped and let a validating backend reject it loudly,
  // as it did before side queries were budgeted. 256 is the smallest budget
  // that can still carry an answer, and it has to sit below the 3 192 the
  // tight-window case pins: `MIN_CLAMPED_OUTPUT_TOKENS` (4 000) is a floor that
  // can itself exceed a tight window, which is what this path must not do.
  if (room < 256) return requestConfig;

  const ceiling = explicitCeiling ?? defaultOutputCeiling(model);
  // Only the window term is this layer's business: when it does not bind,
  // leave the request alone so each wire keeps applying whatever output limit
  // it applied before side queries were budgeted. Two wires apply none at all —
  // Gemini/Vertex (`llm-content-generator.ts`) and OpenAI Responses
  // (`responses-pipeline.ts`) — so always emitting one would cap them at
  // `defaultOutputCeiling` (8 192 for `gemini-2.5-pro`, via the
  // `[/^gemini-/, LIMITS['8k']]` row) and silently truncate side-query output
  // that used to be uncapped.
  //
  // The ceiling has to stay inside this comparison: with an operator ceiling
  // below the room (env 2 000, room 3 000) an auto-ceiling test would emit
  // 3 000 and displace that value, since the ceiling-applying providers read
  // the override only when the request carries no output limit of its own.
  if (room >= ceiling) return requestConfig;

  // Reasoning is paid out of the same budget. The manual Anthropic route clamps
  // `budget_tokens` to `max_tokens - 1` and drops thinking below 1 024, so an
  // unpaired cap goes out as e.g. `max_tokens: 25 536` beside
  // `budget_tokens: 25 535` — one visible token, `generateJson` returns `{}`,
  // and `/insight` drops the session without a word; where no manual clamp runs
  // the same pair is simply invalid (`budget_tokens >= max_tokens`). Cap
  // thinking at half the room through the request-local knob
  // `anthropicContentGenerator.buildThinkingConfig` documents for this case and
  // `chatCompressionService` already ships for its own bounded request — no
  // other generator reads `thinkingConfig.thinkingBudget`. Below ~2 048 of room
  // that 1 024 floor leaves no visible output, so leave the request uncapped
  // and loud rather than silently discarding the reasoning the caller asked
  // for.
  const thinking = requestConfig.thinkingConfig;
  if (!thinking || thinking.includeThoughts === false) {
    return { ...requestConfig, maxOutputTokens: room };
  }
  const thinkingBudget = Math.min(
    thinking.thinkingBudget ?? room,
    Math.floor(room / 2),
  );
  if (thinkingBudget < 1024) return requestConfig;

  return {
    ...requestConfig,
    maxOutputTokens: room,
    thinkingConfig: { ...thinking, thinkingBudget },
  };
}

/**
 * The pair of generator and retry-authType to use for a request targeting
 * a specific model. When the requested model differs from the main session
 * model, both fields are resolved against that model's provider so that
 * per-model `extra_body` / `samplingParams` / reasoning settings — and
 * provider-specific retry/quota behaviour — do not leak from the main
 * session.
 */
export interface ResolvedGeneratorForModel {
  contentGenerator: ContentGenerator;
  contentGeneratorConfig: ContentGeneratorConfig;
  retryAuthType: string | undefined;
  retryErrorCodes?: readonly number[];
  model: string;
  /**
   * Context window of the model this request is actually sent to, resolved
   * against that target: its registry-declared `contextWindowSize`, else
   * `tokenLimit(target, 'input')`. `undefined` when the request falls back to
   * the session generator, whose `contentGeneratorConfig.contextWindowSize`
   * then describes the window the request is handed.
   */
  contextWindowSize?: number;
}

/**
 * Options for the generateText utility function.
 */
export interface GenerateTextOptions {
  /** The input prompt or history. */
  contents: Content[];
  /** The specific model to use for this task. */
  model: string;
  /**
   * Task-specific system instructions. Passed through to the underlying
   * content generator without the llmClient main-prompt fallback or
   * user-memory wrapping that `getCustomSystemPrompt` applies.
   */
  systemInstruction?: GenerateContentConfig['systemInstruction'];
  /**
   * Overrides for generation configuration (e.g., temperature, thinkingConfig,
   * or cache-prefix-preserving tool declarations).
   */
  config?: Omit<GenerateContentConfig, 'systemInstruction' | 'abortSignal'>;
  /** Signal for cancellation. */
  abortSignal: AbortSignal;
  /**
   * A unique ID for the prompt, used for logging/telemetry correlation.
   */
  promptId?: string;
  /**
   * The maximum number of attempts for the request.
   */
  maxAttempts?: number;
  /**
   * Stream the response instead of awaiting the whole non-streaming body.
   * Defaults to `false` (unchanged non-streaming behavior). Opt in to keep the
   * HTTP connection alive against BFF gateways whose `proxy_read_timeout` would
   * otherwise kill a slow inference before the first byte arrives. The streamed
   * deltas are collected into the same `{ text, usage }` result.
   */
  stream?: boolean;
  /**
   * Let the OpenAI adapter mark the unchanged history prefix for cache reuse.
   * This is only for requests ending in a non-reusable trailing directive;
   * the adapter deliberately excludes the final message from cache marking.
   */
  promptCacheSharing?: boolean;
  /**
   * When true, throw instead of silently falling back to the main generator if
   * a distinct generator for `model` can't be created (model not registered, or
   * generator creation fails — e.g. a missing cross-provider credential). The
   * vision bridge sets this so image payloads are never routed at the text-only
   * primary while a notice names a different vision endpoint; it fails the
   * conversion closed instead.
   */
  failClosed?: boolean;
}

/**
 * Result of a generateText call.
 */
export interface GenerateTextResult {
  text: string;
  usage: GenerateContentResponseUsageMetadata | undefined;
  /** Whether the response contained a function call. No call is executed here. */
  hadToolCall?: boolean;
}

/**
 * Best-effort JSON-object extraction from a model's text response. Used as a
 * fallback when the model emits plain-text JSON instead of calling the
 * registered tool. Strips a leading ```json / ``` fence, then takes the
 * substring from the first `{` to the matching last `}` and JSON-parses it.
 * Returns the parsed object on success, or `null` if nothing usable is found.
 */
function parseLooseJsonObject(text: string): Record<string, unknown> | null {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }
  const firstStructuredChar = s.search(/[[{]/);
  if (firstStructuredChar !== -1 && s[firstStructuredChar] === '[') {
    return null;
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(s.slice(first, last + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Options for the generateJson utility function.
 */
export interface GenerateJsonOptions {
  /** The input prompt or history. */
  contents: Content[];
  /** The required JSON schema for the output. */
  schema: Record<string, unknown>;
  /** The specific model to use for this task. */
  model: string;
  /**
   * Task-specific system instructions.
   * If omitted, no system instruction is sent.
   */
  systemInstruction?: string | Part | Part[] | Content;
  /**
   * Overrides for generation configuration (e.g., temperature).
   */
  config?: Omit<
    GenerateContentConfig,
    | 'systemInstruction'
    | 'responseJsonSchema'
    | 'responseMimeType'
    | 'tools'
    | 'abortSignal'
  >;
  /** Signal for cancellation. */
  abortSignal: AbortSignal;
  /**
   * A unique ID for the prompt, used for logging/telemetry correlation.
   */
  promptId?: string;
  /**
   * The maximum number of attempts for the request.
   */
  maxAttempts?: number;
}

/**
 * A client dedicated to stateless, utility-focused LLM calls.
 */
export class BaseLlmClient {
  /**
   * Cache of per-model ContentGenerators keyed by model ID. Avoids rebuilding
   * the generator (SDK instantiation, config resolution) on every side query.
   * Cleared via {@link clearPerModelGeneratorCache} when the session resets.
   */
  private readonly perModelGeneratorCache = new Map<
    string,
    Promise<RuntimeContentGeneratorView>
  >();

  constructor(
    private readonly contentGenerator: ContentGenerator,
    private readonly config: Config,
  ) {}

  private getCurrentContentGenerator(): ContentGenerator {
    return this.config.getContentGenerator?.() ?? this.contentGenerator;
  }

  async generateJson(
    options: GenerateJsonOptions,
  ): Promise<Record<string, unknown>> {
    const {
      contents,
      schema,
      model,
      abortSignal,
      systemInstruction,
      promptId,
      maxAttempts,
    } = options;

    const requestConfig: GenerateContentConfig = {
      abortSignal,
      ...options.config,
      ...(systemInstruction && { systemInstruction }),
    };

    // Convert schema to function declaration
    const functionDeclaration: FunctionDeclaration = {
      name: 'respond_in_schema',
      description: 'Provide the response in provided schema',
      parameters: schema as Schema,
    };

    const tools: Tool[] = [
      {
        functionDeclarations: [functionDeclaration],
      },
    ];

    const {
      contentGenerator,
      contentGeneratorConfig,
      retryAuthType,
      retryErrorCodes,
      model: requestModel,
      contextWindowSize: resolvedContextWindowSize,
    } = await this.resolveForModel(model);
    const requestContents = slimCompactionInput(
      contents,
      contentGeneratorConfig.modalities,
    ).slimmedHistory;
    const budgetedConfig = budgetOutputTokensForWindow(
      requestConfig,
      requestContents,
      requestModel,
      contentGeneratorConfig,
      resolvedContextWindowSize,
      resolveSlimmingConfig(this.config.getChatCompression?.())
        .imageTokenEstimate,
      tools,
    );

    try {
      const apiCall = () =>
        contentGenerator.generateContent(
          {
            model: requestModel,
            config: {
              ...budgetedConfig,
              tools,
              // Force the model to call the respond_in_schema tool rather
              // than free-texting. Without this, Anthropic-native and
              // some OpenAI-compat providers default to tool_choice=auto
              // and may skip the tool call entirely — especially
              // adaptive-thinking models that consume the tiny output
              // budget on thinking before producing any tool_use.
              toolConfig: {
                functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
              },
            },
            contents: requestContents,
          },
          promptId ?? '',
        );

      const result = await retryWithBackoff(apiCall, {
        maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        authType: retryAuthType,
        extraRetryErrorCodes: retryErrorCodes,
        persistentMode: isUnattendedMode(),
        signal: abortSignal,
        heartbeatFn: (info) => {
          process.stderr.write(
            `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
          );
        },
        onRetry: (info) => {
          logApiRetry(
            this.config,
            new ApiRetryEvent({
              model: requestModel,
              promptId,
              attemptNumber: info.attempt,
              error: info.error,
              statusCode: info.errorStatus,
              retryDelayMs: info.delayMs,
              subagentName: subagentNameContext.getStore(),
            }),
          );
        },
      });

      const functionCalls = getFunctionCalls(result);
      if (functionCalls && functionCalls.length > 0) {
        const functionCall = functionCalls.find(
          (call) => call.name === 'respond_in_schema',
        );
        if (functionCall && functionCall.args) {
          return functionCall.args as Record<string, unknown>;
        }
      }

      const text = getResponseText(result);
      if (text) {
        const parsed = parseLooseJsonObject(text);
        if (parsed) return parsed;
      }
      return {};
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }

      // Avoid double reporting for the empty response case handled above
      if (
        error instanceof Error &&
        error.message === 'API returned an empty response for generateJson.'
      ) {
        throw error;
      }

      await reportError(
        error,
        'Error generating JSON content via API.',
        contents,
        'generateJson-api',
      );
      throw new Error(
        `Failed to generate JSON content${promptId ? ` (${promptId})` : ''}: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Free-form text generation primitive used by `runSideQuery` text mode.
   *
   * Distinct from `LlmClient.generateContent`: this calls the underlying
   * `ContentGenerator` directly, so the caller's `systemInstruction` is sent
   * through verbatim — no `getCustomSystemPrompt` wrapping (which would append
   * user memory) and no main-session-prompt fallback when omitted. Side queries
   * need that contract; the main turn does not.
   */
  async generateText(
    options: GenerateTextOptions,
  ): Promise<GenerateTextResult> {
    const {
      contents,
      model,
      abortSignal,
      systemInstruction,
      promptId,
      maxAttempts,
      stream,
    } = options;

    const requestConfig: GenerateContentConfig = {
      abortSignal,
      ...options.config,
      ...(systemInstruction && { systemInstruction }),
    };

    const {
      contentGenerator,
      contentGeneratorConfig,
      retryAuthType,
      retryErrorCodes,
      model: requestModel,
      contextWindowSize: resolvedContextWindowSize,
    } = await this.resolveForModel(model, { failClosed: options.failClosed });
    const requestContents = slimCompactionInput(
      contents,
      contentGeneratorConfig.modalities,
    ).slimmedHistory;
    const budgetedConfig = budgetOutputTokensForWindow(
      requestConfig,
      requestContents,
      requestModel,
      contentGeneratorConfig,
      resolvedContextWindowSize,
      resolveSlimmingConfig(this.config.getChatCompression?.())
        .imageTokenEstimate,
    );

    try {
      const request: PromptCacheSharingParameters = {
        model: requestModel,
        config: budgetedConfig,
        contents: requestContents,
        ...(options.promptCacheSharing && { promptCacheSharing: true }),
      };

      // Both branches resolve to the same `{ text, usage }` shape so a single
      // retryWithBackoff governs the whole request (a mid-stream failure retries
      // the entire call — side queries are idempotent). Streaming keeps the HTTP
      // connection alive so a slow inference can't be killed by a gateway's
      // `proxy_read_timeout`; non-streaming is the unchanged default.
      const apiCall: () => Promise<GenerateTextResult> = stream
        ? async () => {
            const responseStream = await contentGenerator.generateContentStream(
              request,
              promptId ?? '',
            );
            // Chunks are deltas, not cumulative snapshots, so concatenate.
            // getResponseText already drops thought parts; usageMetadata rides
            // the final chunk (last one wins), matching the non-streaming read.
            let text = '';
            let usage: GenerateContentResponseUsageMetadata | undefined;
            let hadToolCall = false;
            for await (const chunk of responseStream) {
              text += getResponseText(chunk) ?? '';
              hadToolCall ||= (getFunctionCalls(chunk)?.length ?? 0) > 0;
              if (chunk.usageMetadata) {
                usage = chunk.usageMetadata;
              }
            }
            return { text, usage, hadToolCall };
          }
        : async () => {
            const result = await contentGenerator.generateContent(
              request,
              promptId ?? '',
            );
            return {
              text: getResponseText(result) ?? '',
              usage: result.usageMetadata,
              hadToolCall: (getFunctionCalls(result)?.length ?? 0) > 0,
            };
          };

      const result = await retryWithBackoff(apiCall, {
        maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        authType: retryAuthType,
        extraRetryErrorCodes: retryErrorCodes,
        persistentMode: isUnattendedMode(),
        signal: abortSignal,
        heartbeatFn: (info) => {
          process.stderr.write(
            `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
          );
        },
        onRetry: (info) => {
          logApiRetry(
            this.config,
            new ApiRetryEvent({
              model: requestModel,
              promptId,
              attemptNumber: info.attempt,
              error: info.error,
              statusCode: info.errorStatus,
              retryDelayMs: info.delayMs,
              subagentName: subagentNameContext.getStore(),
            }),
          );
        },
      });

      return {
        text: result.text.trim(),
        usage: result.usage,
        hadToolCall: result.hadToolCall,
      };
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }

      await reportError(
        error,
        // Mark streaming failures so an oncall can tell a mid-stream error
        // apart from the original non-streaming gateway timeout (#5861).
        `Error generating text content via API${stream ? ' [streaming]' : ''}.`,
        contents,
        'generateText-api',
      );
      throw new Error(
        `Failed to generate text content${promptId ? ` (${promptId})` : ''}: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async generateEmbedding(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }
    const embedModelParams: EmbedContentParameters = {
      model: this.config.getEmbeddingModel(),
      contents: texts,
    };

    const embedContentResponse =
      await this.contentGenerator.embedContent(embedModelParams);
    if (
      !embedContentResponse.embeddings ||
      embedContentResponse.embeddings.length === 0
    ) {
      throw new Error('No embeddings found in API response.');
    }

    if (embedContentResponse.embeddings.length !== texts.length) {
      throw new Error(
        `API returned a mismatched number of embeddings. Expected ${texts.length}, got ${embedContentResponse.embeddings.length}.`,
      );
    }

    return embedContentResponse.embeddings.map((embedding, index) => {
      const values = embedding.values;
      if (!values || values.length === 0) {
        throw new Error(
          `API returned an empty embedding for input text at index ${index}: "${texts[index]}"`,
        );
      }
      return values;
    });
  }

  /**
   * Resolve the ContentGenerator and retry authType for a request targeting
   * a specific model.
   *
   * When the requested model matches the main session model, returns the
   * constructor-injected generator and the main session's authType. When it
   * differs (e.g. a fast model on a different provider), constructs and caches
   * a per-model generator with that provider's auth, baseUrl, sampling, and
   * extra_body settings — and reports the target provider as the retry
   * authType so quota detection and provider-specific retry logic line up.
   *
   * Falls back to the main generator when the target model is not registered
   * or generator creation fails (e.g. tests without full auth setup).
   */
  async resolveForModel(
    model: string,
    opts?: { failClosed?: boolean },
  ): Promise<ResolvedGeneratorForModel> {
    const requested = splitModelBaseUrl(model);
    const selector = this.resolveModelSelector(requested.model);
    const requestModel =
      selector?.modelId ?? this.config.getModel() ?? requested.model;
    const mainModel = this.config.getModel() ?? requested.model;
    const mainGeneratorConfig = this.config.getContentGeneratorConfig();
    const mainAuthType = mainGeneratorConfig?.authType;
    const mainBaseUrl = mainGeneratorConfig?.baseUrl;
    const mainRetryErrorCodes = mainGeneratorConfig?.retryErrorCodes;
    const matchesMainBaseUrl =
      requested.baseUrl === undefined || requested.baseUrl === mainBaseUrl;

    if (
      requestModel === mainModel &&
      (!selector?.authType || selector.authType === mainAuthType) &&
      matchesMainBaseUrl
    ) {
      return {
        contentGenerator: this.getCurrentContentGenerator(),
        contentGeneratorConfig: mainGeneratorConfig,
        retryAuthType: mainAuthType,
        retryErrorCodes: mainRetryErrorCodes,
        model: requestModel,
      };
    }

    const { contentGenerator, contentGeneratorConfig } =
      await this.createRuntimeViewForModel(
        requested.model,
        selector,
        opts?.failClosed ?? false,
        requested.baseUrl,
      );
    const resolvedModel = this.resolveModelAcrossAuthTypes(
      requested.model,
      selector,
      requested.baseUrl,
    );
    const retryAuthType =
      resolvedModel?.authType ?? mainAuthType ?? AuthType.USE_OPENAI;
    const retryErrorCodes =
      resolvedModel?.generationConfig?.retryErrorCodes ?? mainRetryErrorCodes;
    const targetModel = resolvedModel?.id ?? requestModel;
    // `contentGeneratorConfig` is built from `{ ...parentConfig }` and
    // `applyResolvedModelConfig` overwrites `contextWindowSize` only when the
    // registry declares one, so for a same-provider target it carries the
    // *session* model's window. Resolve the window against the target instead.
    // The session value stays authoritative only on the fallback route, where
    // the session generator really is the one sending the request — detected
    // by identity, since that fallback hands back the very object
    // `mainGeneratorConfig` was read from.
    const fellBackToSessionGenerator =
      contentGeneratorConfig === mainGeneratorConfig;

    return {
      contentGenerator,
      contentGeneratorConfig,
      retryAuthType,
      retryErrorCodes,
      model: targetModel,
      contextWindowSize: fellBackToSessionGenerator
        ? undefined
        : (resolvedModel?.generationConfig?.contextWindowSize ??
          tokenLimit(targetModel, 'input')),
    };
  }

  /**
   * Drop cached per-model ContentGenerators. Called on session reset so that
   * the next side query picks up updated provider settings.
   */
  clearPerModelGeneratorCache(): void {
    this.perModelGeneratorCache.clear();
  }

  /**
   * Resolve a model across all authTypes. Handles the case where the target
   * model is registered under a different authType than the main model
   * (e.g. main=QWEN_OAUTH, fast=USE_ANTHROPIC).
   */
  private resolveModelAcrossAuthTypes(
    model: string,
    selector: ResolvedModelId | undefined,
    modelBaseUrl?: string,
  ): ResolvedModelConfig | undefined {
    const modelsConfig = this.config.getModelsConfig?.();
    if (!modelsConfig) return undefined;
    if (!selector) return undefined;
    const modelId = selector.modelId;
    const getResolvedModel = (authType: AuthType) =>
      modelBaseUrl === undefined
        ? modelsConfig.getResolvedModel(authType, modelId)
        : modelsConfig.getResolvedModel(authType, modelId, modelBaseUrl);

    if (selector.authType) {
      return getResolvedModel(selector.authType);
    }

    const allAuthTypes: AuthType[] = [
      AuthType.QWEN_OAUTH,
      AuthType.USE_OPENAI,
      AuthType.USE_VERTEX_AI,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
    ];

    const mainAuthType = this.config.getContentGeneratorConfig()?.authType;
    if (mainAuthType) {
      const resolved = getResolvedModel(mainAuthType);
      if (resolved) return resolved;
    }

    for (const authType of allAuthTypes) {
      if (authType === mainAuthType) continue;
      const resolved = getResolvedModel(authType);
      if (resolved) return resolved;
    }

    return undefined;
  }

  private async createRuntimeViewForModel(
    model: string,
    selector: ResolvedModelId | undefined,
    failClosed = false,
    modelBaseUrl?: string,
  ): Promise<RuntimeContentGeneratorView> {
    const routeKey = selector
      ? modelBaseUrl === undefined
        ? `${selector.authType ?? ''}:${selector.modelId}`
        : `${selector.authType ?? ''}:${selector.modelId}\0${modelBaseUrl}`
      : model;
    const cacheKey = routeKey;
    const cached = this.perModelGeneratorCache.get(cacheKey);
    const normalizeGeneratorError = (err: unknown) =>
      err instanceof Error
        ? err
        : new Error(
            `Failed to create content generator for model "${model}": ${String(err)}`,
          );
    const fallbackAfterGeneratorError = (
      err: unknown,
    ): RuntimeContentGeneratorView => {
      if (failClosed) throw normalizeGeneratorError(err);
      debugLogger.warn(
        `Failed to create content generator for model "${model}", falling back to main generator.`,
        err instanceof Error ? err.message : String(err),
      );
      return {
        contentGenerator: this.getCurrentContentGenerator(),
        contentGeneratorConfig: this.config.getContentGeneratorConfig(),
      };
    };
    if (cached) return cached.catch(fallbackAfterGeneratorError);

    const resolvedModel = this.resolveModelAcrossAuthTypes(
      model,
      selector,
      modelBaseUrl,
    );

    if (!resolvedModel) {
      // failClosed callers (vision bridge) must NOT silently run on the main
      // generator — that would send image payloads to the text-only primary.
      if (failClosed) {
        const baseUrlMessage =
          modelBaseUrl === undefined ? '' : ` at baseUrl "${modelBaseUrl}"`;
        throw new Error(
          `Model "${model}"${baseUrlMessage} is not registered across any auth type; ` +
            `refusing to fall back to the main generator.`,
        );
      }
      debugLogger.warn(
        `Model "${model}" not found in registry across all authTypes, falling back to main generator.`,
      );
      // Do not cache the fallback: getCurrentContentGenerator() reads the
      // runtime view from AsyncLocalStorage, which can differ between calls
      // (e.g. inside a subagent vs. on the main session). Caching here would
      // pin the first-call view's generator under this selector key.
      return {
        contentGenerator: this.getCurrentContentGenerator(),
        contentGeneratorConfig: this.config.getContentGeneratorConfig(),
      };
    }

    const generatorPromise = (async () => {
      try {
        const targetModel = resolvedModel.id ?? selector?.modelId ?? model;
        const targetConfig = buildAgentContentGeneratorConfig(
          this.config,
          targetModel,
          {
            authType: resolvedModel.authType,
            apiKey: resolvedModel.envKey
              ? (process.env[resolvedModel.envKey] ?? undefined)
              : undefined,
            baseUrl: resolvedModel.baseUrl,
          },
        );
        if (resolvedModel.capabilities?.vision) {
          targetConfig.modalities = {
            ...targetConfig.modalities,
            image: true,
          };
        }
        return {
          contentGenerator: await createContentGenerator(
            targetConfig,
            this.config,
          ),
          contentGeneratorConfig: targetConfig,
        };
      } catch (err: unknown) {
        this.perModelGeneratorCache.delete(cacheKey);
        throw normalizeGeneratorError(err);
      }
    })();

    this.perModelGeneratorCache.set(cacheKey, generatorPromise);
    return generatorPromise.catch(fallbackAfterGeneratorError);
  }

  private resolveModelSelector(model: string): ResolvedModelId | undefined {
    return resolveModelId(model, buildModelIdContext(this.config));
  }
}
