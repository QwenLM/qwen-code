/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Document-transform specifics of the agent-prepared Batch workflow:
// assemble one self-contained chat request per item, then validate and
// deliver what comes back. The product contract is "one source document ->
// one complete target document": the model returns content only, paths and
// commands inside its output are data, never executed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  isQwenFamilyWireModel,
  isTieredEffortWireModel,
} from '@qwen-code/qwen-code-core/core/modalityDefaults.js';
import { isWithinRoot } from '../config/path-comparison.js';
import type { BatchPlan, TaskItem } from './batch-task.js';
import { customIdOf, targetProblem } from './batch-task.js';

export const sha256 = (text: string) =>
  crypto.createHash('sha256').update(text).digest('hex');

/**
 * Rough token estimate for budgeting only: ~4 chars/token for Latin text and
 * ~1.5 for CJK and other wide scripts, counted per character so a Chinese
 * document is not under-estimated by half. Never shown as metering; actual
 * usage comes back in the batch output lines.
 */
export const estimateTokens = (text: string) => {
  let latin = 0;
  let wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 0x2e80) latin++;
    else wide++;
  }
  // latin / 4 + wide / 1.5, in integers so the result is exact.
  return Math.max(1, Math.ceil((3 * latin + 8 * wide) / 12));
};

export interface AssembledRequest {
  customId: string;
  itemId: string;
  line: Record<string, unknown>;
  inputTokens: number;
  sourceSha256: string;
}

export class AssemblyError extends Error {}

/**
 * Request parameters frozen from the realtime generation config when a task
 * is created, so Batch runs the same sampling and thinking mode the user
 * already runs — a Batch-only default would make the cost/quality comparison
 * against realtime meaningless — and every retry reuses them instead of
 * whatever the config says later.
 */
export interface FrozenRequest {
  /** Chat-completions body fields (sampling, `max_tokens`, `enable_thinking`). */
  params: Record<string, unknown>;
  /** The model rejects `enable_thinking: false`. */
  thinkingMandatory?: boolean;
  /** Configured settings Batch requests do not reproduce, for the summary. */
  notes: string[];
}

export interface GenerationConfigLike {
  samplingParams?: Record<string, unknown>;
  extra_body?: Record<string, unknown>;
  reasoning?: false | { effort?: string; budget_tokens?: number };
  thinkingMandatory?: boolean;
}

// Output-budget keys some endpoints read instead of `max_tokens`. When the
// frozen params carry one, the limit goes there: realtime never sends it
// alongside `max_tokens`, because some endpoints reject the pair.
const PROVIDER_OUTPUT_BUDGET_KEYS = ['max_completion_tokens', 'max_new_tokens'];

/** The body key an output limit is written under for these params. */
export const outputBudgetKey = (params: Record<string, unknown> = {}) =>
  PROVIDER_OUTPUT_BUDGET_KEYS.find((key) => params[key] !== undefined) ??
  'max_tokens';

/**
 * The Qwen-on-DashScope wire shape for "thinking off", as realtime emits it:
 * the tiered family reads `reasoning_effort`, the rest `enable_thinking`.
 * Enabling a tiered model removes the disable override, preserving its default
 * or an explicitly configured effort. Other model families get nothing here.
 */
export function setThinking(
  params: Record<string, unknown>,
  model: string | undefined,
  enabled: boolean,
): boolean {
  if (isTieredEffortWireModel(model)) {
    delete params['enable_thinking'];
    delete params['thinking_budget'];
    if (!enabled) params['reasoning_effort'] = 'none';
    else if (params['reasoning_effort'] === 'none')
      delete params['reasoning_effort'];
    return true;
  }
  if (isQwenFamilyWireModel(model)) {
    if (enabled && params['reasoning_effort'] === 'none')
      delete params['reasoning_effort'];
    params['enable_thinking'] = enabled;
    return true;
  }
  return false;
}

export function freezeRequest(
  config: GenerationConfigLike | undefined,
  model?: string,
): FrozenRequest {
  const notes: string[] = [];
  // Realtime sends samplingParams and extra_body to the wire verbatim, with
  // extra_body merged last; Batch reproduces exactly that.
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    ...config?.samplingParams,
    ...config?.extra_body,
  })) {
    if (value !== undefined && value !== null) params[key] = value;
  }
  if (
    config?.reasoning === false &&
    !config.thinkingMandatory &&
    params['enable_thinking'] === undefined &&
    params['reasoning_effort'] === undefined &&
    !setThinking(params, model, false)
  ) {
    notes.push(
      `disabled reasoning is not reproduced for ${model ?? 'this model'} in Batch requests; the provider default thinking mode applies`,
    );
  }
  if (
    config?.thinkingMandatory &&
    (config.reasoning === false ||
      params['enable_thinking'] === false ||
      params['reasoning_effort'] === 'none')
  ) {
    if (params['enable_thinking'] === false) delete params['enable_thinking'];
    if (params['reasoning_effort'] === 'none')
      delete params['reasoning_effort'];
    notes.push('thinking cannot be disabled for this model; left on');
  }
  if (
    config?.reasoning &&
    (config.reasoning.effort !== undefined ||
      config.reasoning.budget_tokens !== undefined) &&
    params['enable_thinking'] === undefined &&
    params['reasoning_effort'] === undefined &&
    params['thinking_budget'] === undefined
  ) {
    notes.push(
      'the configured reasoning effort is not reproduced in Batch requests; the provider default thinking mode applies',
    );
  }
  return {
    params,
    ...(config?.thinkingMandatory ? { thinkingMandatory: true } : {}),
    notes,
  };
}

/** One-line description of the thinking mode a frozen request runs with. */
export function describeThinking(request: FrozenRequest | undefined): string {
  const value =
    request?.params['reasoning_effort'] === 'none'
      ? false
      : request?.params['enable_thinking'];
  return value === true
    ? 'thinking on'
    : value === false
      ? 'thinking off'
      : 'thinking: provider default';
}

/**
 * Read each item's source and build its request line. Sources are resolved
 * against the project root recorded in the task; anything escaping it
 * (`../`, absolute paths) is refused before a byte leaves the machine.
 */
export function assembleRequests(
  plan: BatchPlan,
  items: TaskItem[],
  attempt: number,
  projectRoot: string,
  model: string,
  request?: FrozenRequest,
): AssembledRequest[] {
  const requests: AssembledRequest[] = [];
  for (const item of items) {
    const sourcePath = resolveInsideRoot(projectRoot, item.source);
    if (sourcePath === undefined) {
      throw new AssemblyError(
        `item "${item.id}": source "${item.source}" escapes the project root`,
      );
    }
    // The lexical check above does not see symlinks: a source like
    // `docs/key.md -> ~/.ssh/id_rsa` would otherwise be read and uploaded.
    if (!isRealPathInsideRoot(projectRoot, sourcePath)) {
      throw new AssemblyError(
        `item "${item.id}": source "${item.source}" resolves outside the project root`,
      );
    }
    let content: string;
    try {
      content = fs.readFileSync(sourcePath, 'utf8');
    } catch (error) {
      throw new AssemblyError(
        `item "${item.id}": cannot read source ${sourcePath}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const messages: Array<Record<string, string>> = [];
    if (plan.shared.system) {
      messages.push({ role: 'system', content: plan.shared.system });
    }
    // The source body is data for the transform, so it travels inside an
    // explicit envelope that cannot be confused with the instructions.
    messages.push({
      role: 'user',
      content:
        `${plan.shared.instructions}\n\n` +
        `<document path="${item.source}">\n${content}\n</document>`,
    });
    // Frozen realtime parameters first; the plan only overrides what it
    // sets explicitly.
    const body: Record<string, unknown> = {
      ...request?.params,
      model,
      messages,
    };
    if (plan.maxOutputTokens !== undefined) {
      body[outputBudgetKey(request?.params)] = plan.maxOutputTokens;
    }
    if (plan.enableThinking !== undefined) {
      setThinking(body, model, plan.enableThinking);
    }
    const inputTokens = estimateTokens(JSON.stringify(messages));
    requests.push({
      customId: customIdOf(item.id, attempt),
      itemId: item.id,
      line: {
        custom_id: customIdOf(item.id, attempt),
        method: 'POST',
        url: '/v1/chat/completions',
        body,
      },
      inputTokens,
      sourceSha256: sha256(content),
    });
  }
  return requests;
}

// A path that does not exist yet has nothing to follow; the read that
// comes next reports it by name.
function isRealPathInsideRoot(projectRoot: string, p: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    return true;
  }
  const realRoot = fs.realpathSync(projectRoot);
  return isWithinRoot(real, realRoot);
}

function resolveInsideRoot(
  projectRoot: string,
  relative: string,
): string | undefined {
  if (path.isAbsolute(relative)) return undefined;
  const resolved = path.resolve(projectRoot, relative);
  return isWithinRoot(resolved, projectRoot) ? resolved : undefined;
}

export interface OutputLine {
  custom_id?: string;
  response?: { status_code?: number; body?: unknown };
  error?: unknown;
}

/**
 * Parse a provider result file. Without `onMalformed` a bad line throws;
 * with it the line is reported and skipped, so one corrupt line cannot
 * block every other item's delivery — its item then fails as "no result".
 */
export function parseOutputJsonl(
  text: string,
  onMalformed?: (message: string) => void,
): OutputLine[] {
  const lines: OutputLine[] = [];
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo += 1;
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as OutputLine);
    } catch (error) {
      const message = `output line ${lineNo}: ${error instanceof Error ? error.message : String(error)}`;
      if (!onMalformed) throw new Error(message);
      onMalformed(message);
    }
  }
  return lines;
}

export type ResultVerdict =
  | { kind: 'ok'; content: string }
  | {
      kind: 'failed';
      reason: string;
      /** Hit the output limit: resending unchanged would fail the same way. */
      truncated?: boolean;
    };

/**
 * Turn one provider output line into a delivery decision. A billed request
 * can still be unusable — refusal, truncation, an unexpected tool call — so
 * "HTTP 200 from the batch" is necessary but never sufficient.
 */
export function classifyResult(line: OutputLine): ResultVerdict {
  if (line.error !== undefined && line.error !== null) {
    return {
      kind: 'failed',
      reason: `provider error: ${summarize(line.error)}`,
    };
  }
  const status = line.response?.status_code;
  if (status !== 200) {
    return {
      kind: 'failed',
      reason: `request status ${String(status)}: ${summarize(line.response?.body)}`,
    };
  }
  const body = line.response?.body as
    | {
        choices?: Array<{
          finish_reason?: string | null;
          message?: { content?: unknown; tool_calls?: unknown };
        }>;
      }
    | undefined;
  const choice = body?.choices?.[0];
  if (!choice) {
    return { kind: 'failed', reason: 'response body has no choices' };
  }
  if (choice.finish_reason === 'length') {
    return {
      kind: 'failed',
      reason: 'output truncated (finish_reason=length)',
      truncated: true,
    };
  }
  if (choice.finish_reason !== 'stop' && choice.finish_reason != null) {
    return {
      kind: 'failed',
      reason: `unexpected finish_reason=${String(choice.finish_reason)}`,
    };
  }
  const message = choice.message ?? {};
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) ? toolCalls.length > 0 : toolCalls != null) {
    return {
      kind: 'failed',
      reason: 'model returned tool calls; this workflow executes none of them',
    };
  }
  if (typeof message.content !== 'string' || !message.content.trim()) {
    return { kind: 'failed', reason: 'empty completion content' };
  }
  // Deliver exactly what the model returned: leading whitespace and the
  // trailing newline can be meaningful (an indented code block), so trim()
  // only guards emptiness, never edits the document. Truncation is caught by
  // finish_reason above.
  return { kind: 'ok', content: message.content };
}

const summarize = (value: unknown) => JSON.stringify(value)?.slice(0, 300);

export type DeliveryOutcome =
  | { kind: 'delivered'; targetPath: string }
  | { kind: 'held'; reason: string; sourceChanged?: true };

/**
 * Publish one validated result. No-overwrite is the contract: a target that
 * exists with different content is a conflict to report, not something to
 * clobber; a target that already holds exactly this content counts as
 * delivered, which is what makes re-running collect idempotent.
 */
export function deliverResult(
  item: TaskItem,
  content: string,
  projectRoot: string,
  expectedSourceSha256: string | undefined,
): DeliveryOutcome {
  const targetPath = resolveInsideRoot(projectRoot, item.target);
  if (targetPath === undefined) {
    return {
      kind: 'held',
      reason: `target "${item.target}" escapes the project root`,
    };
  }
  if (expectedSourceSha256 !== undefined) {
    const sourcePath = resolveInsideRoot(projectRoot, item.source);
    let current: string | undefined;
    try {
      current =
        sourcePath === undefined
          ? undefined
          : sha256(fs.readFileSync(sourcePath, 'utf8'));
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      return {
        kind: 'held',
        reason: `source "${item.source}" is no longer readable; not writing a transform of a vanished input`,
      };
    }
    if (current !== expectedSourceSha256) {
      return {
        kind: 'held',
        reason: `source "${item.source}" changed since submission; \`qwen batch retry\` resubmits it against the new source`,
        sourceChanged: true,
      };
    }
  }
  const parent = path.dirname(targetPath);
  const realRoot = fs.realpathSync(projectRoot);
  // Containment must be proven before anything is created: with a symlink
  // in the existing chain (linked -> /outside), a recursive mkdir would
  // otherwise create the missing tail outside the project first.
  let ancestor = parent;
  while (!fs.existsSync(ancestor)) {
    const up = path.dirname(ancestor);
    if (up === ancestor) break;
    ancestor = up;
  }
  if (!isWithinRoot(fs.realpathSync(ancestor), realRoot)) {
    return {
      kind: 'held',
      reason: `target directory "${item.target}" resolves outside the project root`,
    };
  }
  const ancestorProblem = targetProblem(
    path.relative(realRoot, fs.realpathSync(ancestor)),
  );
  if (ancestorProblem) {
    return {
      kind: 'held',
      reason: `target directory "${item.target}" ${ancestorProblem}`,
    };
  }
  fs.mkdirSync(parent, { recursive: true });
  // Revalidate the created parent: the chain must really live under the
  // project at delivery time, not just before the mkdir.
  const realParent = fs.realpathSync(parent);
  if (!isWithinRoot(realParent, realRoot)) {
    return {
      kind: 'held',
      reason: `target directory "${item.target}" resolves outside the project root`,
    };
  }
  const parentProblem = targetProblem(path.relative(realRoot, realParent));
  if (parentProblem) {
    return {
      kind: 'held',
      reason: `target directory "${item.target}" ${parentProblem}`,
    };
  }
  if (fs.existsSync(targetPath)) {
    const existing = fs.readFileSync(targetPath, 'utf8');
    if (existing === content) {
      return { kind: 'delivered', targetPath };
    }
    return {
      kind: 'held',
      reason: `target "${item.target}" already exists with different content; kept both`,
    };
  }
  // Exclusive create: a target that appeared since the check above (another
  // collect, an editor save) is refused, never overwritten.
  try {
    fs.writeFileSync(targetPath, content, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      // The exclusive create means a file left at targetPath is this write's
      // own partial: remove it, or the next collect reads the truncated
      // debris as a user edit and wedges the item as a permanent conflict.
      try {
        fs.rmSync(targetPath, { force: true });
      } catch {
        // The write error is the one to report.
      }
      throw error;
    }
    return {
      kind: 'held',
      reason: `target "${item.target}" appeared while delivering; kept both`,
    };
  }
  return { kind: 'delivered', targetPath };
}
