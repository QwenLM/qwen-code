/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { SessionService } from './sessionService.js';
import type { ChatRecord } from './chatRecordingService.js';
import { estimateContentTokens } from './tokenEstimation.js';

/** Default token budget for an injected slimmed session reference. */
export const SESSION_REF_TOKEN_BUDGET = 8000;

export interface SlimmedSessionReference {
  /** Labeled, budget-trimmed block ready to inject as a text part. */
  text: string;
  meta: {
    sessionId: string;
    title: string;
    messageCount: number;
    approxTokens: number;
  };
  /** True when older turns were dropped to fit the budget. */
  truncated: boolean;
}

interface FunctionCallPart {
  functionCall?: { name?: string };
  functionResponse?: { name?: string };
}

interface ThoughtPart {
  thought?: boolean;
}

/**
 * Loads a prior chat session and turns it into a deterministically slimmed,
 * read-only text block suitable for injecting into the current context as
 * reference material. No model/LLM call is made — slimming is purely
 * mechanical.
 *
 * Slimming rules:
 * - user / assistant visible text is kept (thoughts dropped);
 * - each tool call collapses to a single line `[tool: <name> — <status>]`
 *   (never the tool result body);
 * - the joined transcript is tail-retained to a fixed token budget, dropping
 *   the oldest turns first.
 */
export class SessionReferenceService {
  private readonly sessionService: SessionService;

  constructor(cwd: string) {
    this.sessionService = new SessionService(cwd);
  }

  // Indirection kept as an instance method so tests can stub it.
  protected loadSession(sessionId: string) {
    return this.sessionService.loadSession(sessionId);
  }

  async resolve(
    sessionId: string,
    opts: { budgetTokens?: number; title?: string } = {},
  ): Promise<SlimmedSessionReference | { notFound: true }> {
    const resumed = await this.loadSession(sessionId);
    if (!resumed) return { notFound: true };

    const records = resumed.conversation.messages ?? [];
    const lines = this.recordsToLines(records);
    const budget = opts.budgetTokens ?? SESSION_REF_TOKEN_BUDGET;

    const kept = [...lines];
    let truncated = false;
    while (kept.length > 0 && this.estimate(kept) > budget) {
      kept.shift(); // drop oldest first (tail-retention)
      truncated = true;
    }

    const title = opts.title ?? sessionId;
    const header = `--- Referenced session "${title}" (slimmed, read-only) ---`;
    const body =
      (truncated ? '[earlier turns omitted]\n' : '') + kept.join('\n');
    const text =
      body.trim().length === 0
        ? `${header}\n(no textual content)`
        : `${header}\n${body}`;

    return {
      text,
      meta: {
        sessionId,
        title,
        messageCount: records.length,
        approxTokens: this.estimate(kept),
      },
      truncated,
    };
  }

  private estimate(lines: string[]): number {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: lines.join('\n') }] },
    ];
    return estimateContentTokens(contents);
  }

  private recordsToLines(records: ChatRecord[]): string[] {
    const out: string[] = [];
    for (const rec of records) {
      if (rec.toolCallResult || this.hasFunctionPart(rec.message)) {
        const name = this.functionName(rec.message) ?? 'tool';
        const status = rec.toolCallResult?.error ? 'error' : 'ok';
        out.push(`[tool: ${name} — ${status}]`);
        continue;
      }
      if (rec.type === 'user') {
        const text = this.visibleText(rec.message);
        if (text) out.push(`User: ${text}`);
      } else if (rec.type === 'assistant') {
        const text = this.visibleText(rec.message);
        if (text) out.push(`Assistant: ${text}`);
      }
      // system records ignored
    }
    return out;
  }

  private visibleText(message?: Content): string {
    if (!message?.parts) return '';
    return message.parts
      .filter((p: Part) => !(p as ThoughtPart).thought && p.text)
      .map((p: Part) => p.text)
      .join('')
      .trim();
  }

  private hasFunctionPart(message?: Content): boolean {
    return (
      message?.parts?.some(
        (p: Part) =>
          (p as FunctionCallPart).functionCall ||
          (p as FunctionCallPart).functionResponse,
      ) ?? false
    );
  }

  private functionName(message?: Content): string | undefined {
    const p = message?.parts?.find(
      (x: Part) =>
        (x as FunctionCallPart).functionCall ||
        (x as FunctionCallPart).functionResponse,
    ) as FunctionCallPart | undefined;
    return p?.functionCall?.name ?? p?.functionResponse?.name;
  }
}
