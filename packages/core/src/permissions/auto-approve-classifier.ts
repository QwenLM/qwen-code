/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGenerator } from '../core/contentGenerator.js';

/**
 * Result of the auto-approve classifier.
 *
 * - `allow`: Safe to auto-approve without user confirmation.
 * - `deny`:  Dangerous — block immediately.
 * - `ask`:   Ambiguous — defer to the user.
 */
export interface ClassifierResult {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
}

/**
 * Options for constructing an {@link AutoApproveClassifier}.
 */
export interface AutoApproveClassifierOptions {
  /** Maximum number of auto-approvals per session before requiring user input. */
  maxPerSession?: number;
  /** Regex patterns (as strings) for commands that should always be denied. */
  denyPatterns?: string[];
  /** Regex patterns (as strings) for commands that should always be allowed. */
  allowPatterns?: string[];
}

/**
 * ML-based auto-approval classifier that uses fast-path pattern matching
 * combined with a cheap model side-query to decide allow/deny/ask for
 * ambiguous tool calls.
 *
 * Eliminates the binary YOLO vs always-ask problem by providing a middle
 * ground: safe read-only operations and well-known commands are auto-approved,
 * dangerous operations are auto-denied, and everything else is classified by
 * a lightweight model query.
 *
 * Evaluation order:
 *   1. Deny patterns (shell commands only) — fast-path deny
 *   2. Allow patterns (shell commands only) — fast-path allow
 *   3. Read-only tool allowlist — fast-path allow
 *   4. Session rate limit — fall back to ask
 *   5. Model side-query — classify ambiguous cases
 *   6. Side-query failure — fall back to ask (never blocks)
 */
export class AutoApproveClassifier {
  private approvalCount = 0;
  private readonly maxPerSession: number;
  private readonly denyPatterns: RegExp[];
  private readonly allowPatterns: RegExp[];

  constructor(
    private readonly getContentGenerator: () => ContentGenerator | null,
    private readonly getModel: () => string,
    options?: AutoApproveClassifierOptions,
  ) {
    this.maxPerSession = options?.maxPerSession ?? 50;

    this.denyPatterns = (
      options?.denyPatterns ?? [
        'rm\\s+-rf\\s+[/*]',
        'git\\s+push\\s+--force',
        'git\\s+reset\\s+--hard',
        'DROP\\s+TABLE',
        'DELETE\\s+FROM.*WHERE\\s+1',
        'chmod\\s+777',
        'curl.*\\|\\s*(bash|sh)',
      ]
    ).map((p) => new RegExp(p, 'i'));

    this.allowPatterns = (
      options?.allowPatterns ?? [
        '^git\\s+(status|log|diff|branch|show)',
        '^ls\\b',
        '^cat\\b',
        '^head\\b',
        '^tail\\b',
        '^echo\\b',
        '^pwd$',
        '^npm\\s+(test|run\\s+test|run\\s+lint)',
        '^node\\s+--version',
      ]
    ).map((p) => new RegExp(p, 'i'));
  }

  /**
   * Classify a tool call as allow/deny/ask.
   *
   * Fast-path pattern matching handles the common cases without any model
   * call. Ambiguous cases fall through to a lightweight side-query.
   * If the side-query fails or times out, the result is always 'ask'
   * (never blocks the agent loop).
   */
  async classify(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: { recentActions?: string[] },
  ): Promise<ClassifierResult> {
    // Fast path: pattern matching for shell commands
    if (
      toolName === 'run_shell_command' &&
      typeof toolInput['command'] === 'string'
    ) {
      const cmd = toolInput['command'];

      // Check deny patterns first (highest priority)
      for (const pattern of this.denyPatterns) {
        if (pattern.test(cmd)) {
          return {
            decision: 'deny',
            reason: `Command matches deny pattern: ${pattern.source}`,
          };
        }
      }

      // Check allow patterns
      for (const pattern of this.allowPatterns) {
        if (pattern.test(cmd)) {
          this.approvalCount++;
          return { decision: 'allow', reason: 'Command matches allow pattern' };
        }
      }
    }

    // Fast path: read-only tools are always safe
    const readOnlyTools = [
      'read_file',
      'grep_search',
      'glob',
      'list_directory',
      'lsp',
      'web_search',
    ];
    if (readOnlyTools.includes(toolName)) {
      this.approvalCount++;
      return { decision: 'allow', reason: 'Read-only tool' };
    }

    // Rate limiting: after N auto-approvals, require user input
    if (this.approvalCount >= this.maxPerSession) {
      return {
        decision: 'ask',
        reason: `Auto-approval limit reached (${this.maxPerSession} per session)`,
      };
    }

    // Side-query to model for ambiguous cases
    try {
      const result = await this.sideQuery(toolName, toolInput, context);
      if (result.decision === 'allow') {
        this.approvalCount++;
      }
      return result;
    } catch {
      // If side-query fails, fall through to ask — never block the agent loop
      return { decision: 'ask', reason: 'Classifier side-query failed' };
    }
  }

  /**
   * Query the model to classify an ambiguous tool call.
   *
   * Uses a minimal prompt with temperature=0 and maxOutputTokens=10
   * to get a fast, deterministic ALLOW/DENY/ASK response.
   */
  private async sideQuery(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: { recentActions?: string[] },
  ): Promise<ClassifierResult> {
    const contentGenerator = this.getContentGenerator();
    if (!contentGenerator) {
      return { decision: 'ask', reason: 'No content generator available' };
    }

    const prompt = this.buildClassifierPrompt(toolName, toolInput, context);

    const response = await contentGenerator.generateContent(
      {
        model: this.getModel(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction:
            'You are a security classifier. Respond with ONLY one word: ALLOW, DENY, or ASK. Nothing else.',
          maxOutputTokens: 10,
          temperature: 0,
        },
      },
      'classifier',
    );

    const text = response.text?.trim().toUpperCase() ?? '';

    if (text.includes('ALLOW'))
      return { decision: 'allow', reason: 'Classifier approved' };
    if (text.includes('DENY'))
      return { decision: 'deny', reason: 'Classifier denied' };
    return { decision: 'ask', reason: 'Classifier deferred to user' };
  }

  private buildClassifierPrompt(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: { recentActions?: string[] },
  ): string {
    const recentContext = context.recentActions?.slice(-5).join('\n') ?? 'None';

    // Truncate input to avoid excessive token usage on the side-query
    const inputStr = JSON.stringify(toolInput, null, 2).slice(0, 500);

    return `Classify this tool call as ALLOW (safe, routine), DENY (dangerous, destructive), or ASK (needs human review).

Tool: ${toolName}
Input: ${inputStr}

Recent actions:
${recentContext}

Rules:
- ALLOW: Read operations, standard build/test commands, file edits in the project
- DENY: Destructive operations (rm -rf, force push, DROP TABLE), system-level changes, network exfiltration
- ASK: Anything ambiguous, first-time patterns, operations outside the project directory

Respond with one word: ALLOW, DENY, or ASK`;
  }

  /** Reset the per-session approval counter. Call at session start. */
  reset(): void {
    this.approvalCount = 0;
  }
}
