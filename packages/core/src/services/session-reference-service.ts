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

interface CustomTitlePayload {
  customTitle?: string;
}

/**
 * Loads a prior chat session and turns it into a deterministically slimmed,
 * read-only text block suitable for injecting into the current context as
 * reference material. No model/LLM call is made — slimming is purely
 * mechanical.
 *
 * Slimming rules:
 * - user / assistant visible text is kept (thoughts dropped), including the
 *   preamble on an assistant turn that also calls a tool;
 * - each tool call collapses to a single line `[tool: <name> — <status>]`
 *   (never the tool result body), derived from the response side;
 * - the joined transcript is tail-retained to a fixed token budget, dropping
 *   the oldest turns first but always keeping at least the newest line.
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

    const title = opts.title ?? this.deriveTitle(records) ?? sessionId;
    const header = `--- Referenced session "${title}" (slimmed, read-only) ---`;
    const overhead = this.estimate([header, '[earlier turns omitted]']);

    // Single-pass tail-retention: estimate each line once, then accumulate
    // from the newest line backward until the budget is reached. Avoids the
    // O(N²) cost of re-joining and re-scanning all remaining lines per
    // dropped line (which dominated resolve() time for long sessions).
    const perLine = lines.map((l) => this.estimate([l]));
    let total = overhead;
    let start = lines.length;
    while (start > 0 && total + perLine[start - 1] <= budget) {
      total += perLine[start - 1];
      start--;
    }
    // Always keep at least the newest line so an over-budget final turn
    // still yields content (rather than collapsing to just the marker).
    if (start === lines.length && lines.length > 0) {
      start = lines.length - 1;
    }
    const kept = lines.slice(start);
    const truncated = start > 0;

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
        approxTokens: this.estimate(kept) + overhead,
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
      // User / assistant visible text. An assistant turn that also calls tools
      // is a SINGLE record carrying both the text and the functionCall parts,
      // so we must emit its text here rather than short-circuiting on the tool
      // parts (which would silently drop the assistant's reasoning).
      if (rec.type === 'user') {
        const text = this.visibleText(rec.message);
        if (text) out.push(`User: ${text}`);
      } else if (rec.type === 'assistant') {
        const text = this.visibleText(rec.message);
        if (text) out.push(`Assistant: ${text}`);
      }

      // Tool summaries: derived ONLY from the response side (functionResponse),
      // which carries the accurate status via `toolCallResult`. The call side
      // (functionCall on the assistant record) is intentionally NOT summarized
      // to avoid a duplicate, always-"ok" line. Never includes result bodies.
      for (const name of this.functionResponseNames(rec.message)) {
        const status = rec.toolCallResult?.error ? 'error' : 'ok';
        out.push(`[tool: ${name} — ${status}]`);
      }
      // system records contribute nothing
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

  private static readonly TITLE_MAX_LENGTH = 80;

  private deriveTitle(records: ChatRecord[]): string | undefined {
    // Prefer the user's explicitly set session title (custom_title system
    // record) over the first user message, so a renamed session shows its
    // chosen name rather than the original prompt.
    for (const rec of records) {
      if (rec.type === 'system' && rec.subtype === 'custom_title') {
        const payload = rec.systemPayload as CustomTitlePayload | undefined;
        if (payload?.customTitle) return payload.customTitle;
      }
    }
    for (const rec of records) {
      if (rec.type !== 'user') continue;
      const text = this.visibleText(rec.message);
      if (!text) continue;
      const firstLine = text.split('\n')[0].trim();
      if (firstLine.length === 0) continue;
      return firstLine.length > SessionReferenceService.TITLE_MAX_LENGTH
        ? firstLine.slice(0, SessionReferenceService.TITLE_MAX_LENGTH - 3) +
            '...'
        : firstLine;
    }
    return undefined;
  }

  /** Names of every `functionResponse` part in a record (parallel tool calls
   * each yield their own line; a single tool call yields one). */
  private functionResponseNames(message?: Content): string[] {
    if (!message?.parts) return [];
    return message.parts
      .map((p: Part) => (p as FunctionCallPart).functionResponse?.name)
      .filter(
        (name): name is string => typeof name === 'string' && name.length > 0,
      );
  }
}
