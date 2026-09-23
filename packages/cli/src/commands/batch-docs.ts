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
import type { BatchPlan, TaskItem } from './batch-task.js';
import { customIdOf } from './batch-task.js';

export const sha256 = (text: string) =>
  crypto.createHash('sha256').update(text).digest('hex');

/**
 * Rough token estimate for budgeting only: ~3 chars/token splits the
 * difference between English (~4) and CJK (~1.5) prose. It is never shown
 * as metering; actual usage comes back in the batch output lines.
 */
export const estimateTokens = (text: string) =>
  Math.max(1, Math.ceil([...text].length / 3));

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

// Only fields verified as DashScope chat-completions body parameters; other
// generation-config keys are SDK/adapter options, not wire JSON.
const FROZEN_SAMPLING_FIELDS = [
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'seed',
  'max_tokens',
] as const;

export interface GenerationConfigLike {
  samplingParams?: Record<string, unknown>;
  extra_body?: Record<string, unknown>;
  reasoning?: false | { effort?: string; budget_tokens?: number };
  thinkingMandatory?: boolean;
}

export function freezeRequest(
  config: GenerationConfigLike | undefined,
): FrozenRequest {
  const params: Record<string, unknown> = {};
  const notes: string[] = [];
  const sampling = config?.samplingParams ?? {};
  for (const field of FROZEN_SAMPLING_FIELDS) {
    if (sampling[field] !== undefined && sampling[field] !== null) {
      params[field] = sampling[field];
    }
  }
  // Same precedence the realtime DashScope adapter applies: an explicit
  // sampling switch, then extra_body, then a disabled reasoning config.
  const thinking =
    typeof sampling['enable_thinking'] === 'boolean'
      ? sampling['enable_thinking']
      : typeof config?.extra_body?.['enable_thinking'] === 'boolean'
        ? (config.extra_body['enable_thinking'] as boolean)
        : config?.reasoning === false
          ? false
          : undefined;
  if (thinking === false && config?.thinkingMandatory) {
    notes.push('thinking cannot be disabled for this model; left on');
  } else if (thinking !== undefined) {
    params['enable_thinking'] = thinking;
  }
  if (
    config?.reasoning &&
    (config.reasoning.effort !== undefined ||
      config.reasoning.budget_tokens !== undefined) &&
    thinking === undefined
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
  const value = request?.params['enable_thinking'];
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
      body['max_tokens'] = plan.maxOutputTokens;
    }
    if (plan.enableThinking !== undefined) {
      body['enable_thinking'] = plan.enableThinking;
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

/**
 * `p` is `root` or below it. Uses `path.relative`, so a root that already
 * ends in a separator (`/`, `C:\\`) and a different Windows drive both work.
 */
export function isInsideRoot(root: string, p: string): boolean {
  const relative = path.relative(root, p);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  // `..foo` is a file inside the root; only a `..` segment leaves it.
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
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
  return isInsideRoot(realRoot, real);
}

function resolveInsideRoot(
  projectRoot: string,
  relative: string,
): string | undefined {
  if (path.isAbsolute(relative)) return undefined;
  const resolved = path.resolve(projectRoot, relative);
  return isInsideRoot(projectRoot, resolved) ? resolved : undefined;
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
  const content = message.content.trim();
  // A truncated markdown transform most visibly breaks fence pairing; it is
  // a cheap structural signal, not a quality claim.
  if ((content.match(/```/g)?.length ?? 0) % 2 !== 0) {
    return { kind: 'failed', reason: 'unbalanced markdown code fences' };
  }
  return { kind: 'ok', content };
}

const summarize = (value: unknown) => JSON.stringify(value)?.slice(0, 300);

export type DeliveryOutcome =
  | { kind: 'delivered'; targetPath: string }
  | { kind: 'held'; reason: string };

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
        reason: `source "${item.source}" changed since submission; review before overwriting its transform`,
      };
    }
  }
  const parent = path.dirname(targetPath);
  fs.mkdirSync(parent, { recursive: true });
  // Symlink escape: the parent chain must really live under the project.
  const realParent = fs.realpathSync(parent);
  const realRoot = fs.realpathSync(projectRoot);
  if (!isInsideRoot(realRoot, realParent)) {
    return {
      kind: 'held',
      reason: `target directory "${item.target}" resolves outside the project root`,
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
  // Publish without a check-then-overwrite window: link() fails if the
  // target appeared since the existence check above (another collect, an
  // editor save), where rename() would silently replace it.
  const tmp = `${targetPath}.${process.pid}.batch-tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.linkSync(tmp, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return {
        kind: 'held',
        reason: `target "${item.target}" appeared while delivering; kept both`,
      };
    }
    // Filesystems without hard links: exclusive create still refuses to
    // overwrite, at the cost of atomicity.
    try {
      fs.writeFileSync(targetPath, content, { flag: 'wx' });
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') {
        return {
          kind: 'held',
          reason: `target "${item.target}" appeared while delivering; kept both`,
        };
      }
      throw fallbackError;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { kind: 'delivered', targetPath };
}
