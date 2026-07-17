/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import AjvPkg from 'ajv';
import { jsonrepair } from 'jsonrepair';
import type { Config } from '../config/config.js';
import {
  AgentHeadless,
  ContextState,
} from '../agents/runtime/agent-headless.js';

/** Max schema-validation retries after the first attempt. */
const SCHEMA_RETRIES = 2;

export interface AgentSpawnRequest {
  prompt: string;
  systemContext: string;
  model?: string;
  agentType?: string;
  /** JSON Schema. When present, the result MUST validate or the spawn fails. */
  schema?: Record<string, unknown>;
  /** Honored by spawners that can bind a working dir (SessionSpawner). */
  cwd?: string;
  signal?: AbortSignal;
}

export interface AgentSpawnResult {
  text?: string;
  structured?: unknown;
  tokens: number;
}

export interface AgentSpawner {
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>;
}

// Ajv's ESM/CJS interop: use 'any' for compatibility as recommended by Ajv docs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvPkg as any).default || AjvPkg;
const ajv = new AjvClass({ allErrors: true, strict: false });

/** Extract the first balanced JSON object/array substring from model prose. */
function extractJson(text: string): string {
  const start = text.search(/[[{]/);
  if (start < 0) return text;
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

export type SchemaCheck =
  | { valid: true; value: unknown }
  | { valid: false; error: string };

/** Parse (repairing if needed) then validate model output against a JSON Schema. */
export function validateAgainstSchema(
  text: string,
  schema: Record<string, unknown>,
): SchemaCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(extractJson(text)));
    } catch {
      return { valid: false, error: 'reply was not JSON' };
    }
  }
  const validate = ajv.compile(schema);
  if (validate(parsed)) return { valid: true, value: parsed };
  return { valid: false, error: ajv.errorsText(validate.errors) };
}

/**
 * Core spawner: wraps the headless agent runtime (design: "HeadlessSpawner").
 * Works offline. Schema enforcement is Ajv-over-final-text with bounded retries
 * (see the spawner.ts deviation note — the runtime has no StructuredOutput
 * read-back).
 */
export class HeadlessSpawner implements AgentSpawner {
  constructor(private readonly config: Config) {}

  async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    let tokens = 0;
    let lastError = '';
    const attempts = req.schema ? SCHEMA_RETRIES + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const systemPrompt = req.schema
        ? `${req.systemContext}\n\nReply with ONLY a JSON value conforming to this JSON Schema:\n${JSON.stringify(req.schema)}` +
          (lastError
            ? `\n\nYour previous reply was invalid (${lastError}). Return corrected JSON only.`
            : '')
        : req.systemContext;

      const agent = await AgentHeadless.create(
        req.agentType ?? 'workflow-agent',
        this.config,
        { systemPrompt },
        req.model ? { model: req.model } : {},
        {},
      );
      const ctx = new ContextState();
      ctx.set('task_prompt', req.prompt);
      await agent.execute(ctx, req.signal);

      tokens += agent.getStatistics().totalTokens ?? 0;
      const text = agent.getFinalText();

      if (!req.schema) return { text, tokens };

      const check = validateAgainstSchema(text, req.schema);
      if (check.valid) return { structured: check.value, tokens };
      lastError = check.error;
    }
    // Exhausted retries → the bridge (Task 10) maps a throw to a null result.
    throw new Error(
      `schema validation failed after ${attempts} attempts: ${lastError}`,
    );
  }
}
