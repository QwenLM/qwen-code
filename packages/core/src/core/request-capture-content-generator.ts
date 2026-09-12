/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Records what a model was actually asked, for off-contract diffs.
 *
 * The experimental collaboration gate has to prove a negative: with the gate
 * off, nothing collaboration-shaped reaches the model. Reading the source
 * cannot establish that — the successor architecture says so, and this branch
 * has repeatedly found that reading misses things. The only way to show it is
 * to look at the request the model actually received, once with the gate off
 * and once on, and diff the two.
 *
 * Nothing captured that today: the request is assembled and sent, with no
 * point in between where its final shape can be read. This decorator is that
 * point. It writes one JSON line per request — the final system instruction,
 * the tool names declared, and the session's source type — and passes the
 * request through untouched.
 *
 * Test-only by construction. It is installed only when
 * `QWEN_CODE_CAPTURE_REQUESTS` names a file, so a production run never
 * constructs it and never pays for it. The wrapper is transparent either way:
 * it forwards every method and alters no request.
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import * as fs from 'node:fs';
import type { ContentGenerator } from './contentGenerator.js';

/** The env var naming the capture file. Absent means no capture at all. */
export const REQUEST_CAPTURE_PATH_ENV = 'QWEN_CODE_CAPTURE_REQUESTS';

/** One captured request. Written as a JSON line so a diff can be scripted. */
export interface CapturedRequest {
  at: number;
  /** `generateContent` or `generateContentStream`. */
  method: string;
  userPromptId: string;
  /** The session's attribution, so captures can be grouped by session kind. */
  sessionSourceType?: string;
  sessionId?: string;
  model?: string;
  /**
   * The system instruction as the model received it, flattened to text. A
   * structured instruction is joined so two captures stay comparable.
   */
  systemInstruction?: string;
  /** Declared tool names, sorted, so ordering noise does not show as a diff. */
  toolNames: string[];
}

/** Flattens whatever shape the caller used into comparable text. */
function flattenSystemInstruction(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      if (typeof record['text'] === 'string') parts.push(record['text']);
      if (record['parts'] !== undefined) visit(record['parts']);
    }
  };
  visit(value);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Every tool name the request declares, sorted.
 *
 * Names rather than whole schemas: the question this answers is which tools
 * were on offer, and a full schema dump buries that in noise. A schema-level
 * diff, if one is ever needed, is a separate capture.
 */
function collectToolNames(request: GenerateContentParameters): string[] {
  const tools = request.config?.tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    const declarations = (tool as { functionDeclarations?: unknown })
      ?.functionDeclarations;
    if (!Array.isArray(declarations)) continue;
    for (const declaration of declarations) {
      const name = (declaration as { name?: unknown })?.name;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names.sort();
}

/** What the decorator needs from a Config. Kept narrow so tests can fake it. */
export interface RequestCaptureSessionInfo {
  getSessionId(): string;
  getSessionSourceType(): string | undefined;
}

/**
 * Wraps a generator and records each request before forwarding it.
 *
 * A capture failure never fails the turn: this exists to observe a run, and
 * taking the run down to report on it would defeat the purpose. Write errors
 * are swallowed deliberately.
 */
export class RequestCaptureContentGenerator implements ContentGenerator {
  constructor(
    private readonly inner: ContentGenerator,
    private readonly session: RequestCaptureSessionInfo,
    private readonly filePath: string,
  ) {}

  private record(
    method: string,
    request: GenerateContentParameters,
    userPromptId: string,
  ): void {
    try {
      const entry: CapturedRequest = {
        at: Date.now(),
        method,
        userPromptId,
        ...(this.session.getSessionSourceType() !== undefined
          ? { sessionSourceType: this.session.getSessionSourceType() }
          : {}),
        sessionId: this.session.getSessionId(),
        ...(typeof request.model === 'string' ? { model: request.model } : {}),
        ...(flattenSystemInstruction(request.config?.systemInstruction) !==
        undefined
          ? {
              systemInstruction: flattenSystemInstruction(
                request.config?.systemInstruction,
              ),
            }
          : {}),
        toolNames: collectToolNames(request),
      };
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch {
      // Observation must not break the thing being observed.
    }
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    this.record('generateContent', request, userPromptId);
    return this.inner.generateContent(request, userPromptId);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    this.record('generateContentStream', request, userPromptId);
    return this.inner.generateContentStream(request, userPromptId);
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.inner.embedContent(request);
  }

  /**
   * Forwarded when the wrapped generator has it. `countTokens` is not on the
   * `ContentGenerator` interface but several implementations carry it, and a
   * decorator that dropped it would change behaviour it is meant to leave
   * alone.
   */
  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const inner = this.inner as ContentGenerator & {
      countTokens?: (
        request: CountTokensParameters,
      ) => Promise<CountTokensResponse>;
    };
    if (typeof inner.countTokens !== 'function') {
      throw new Error('The wrapped content generator cannot count tokens.');
    }
    return inner.countTokens(request);
  }
}

/**
 * Installs the capture wrapper when the env var names a file.
 *
 * Returns the generator untouched otherwise, so the only cost on a normal run
 * is one env lookup.
 */
export function withRequestCapture(
  generator: ContentGenerator,
  session: RequestCaptureSessionInfo,
): ContentGenerator {
  const filePath = process.env[REQUEST_CAPTURE_PATH_ENV];
  if (!filePath) return generator;
  return new RequestCaptureContentGenerator(generator, session, filePath);
}
