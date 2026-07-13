/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Read what the review's agents actually did, from the harness's own records.
//
// Every gate this skill has built read a file the orchestrator wrote, and the
// orchestrator is the thing being checked. The coverage gate asked it to copy the
// agents' returns into `returns.txt`; on its sixth dogfood it fabricated them
// instead — invented file lists, invented `Covered: chunk N lines X-Y` — and the
// check reported 23/23 covered over a diff nobody had read. Evidence authored by
// the subject is not evidence.
//
// The harness writes its own record of every subagent: `<projectDir>/subagents/
// <sessionId>/agent-<id>.jsonl`, one line per event, opened at launch and flushed
// per record. The orchestrator does not author it, is never told its path, and
// cannot retcon it — the launch prompt is the file's first line, written before
// the model has said anything.
//
// Two things are read out of it, and they answer different questions:
//
//   - **Was this agent able to work at all?** Its launch prompt is in the record.
//     Measured across the real runs, 23 of 23 chunk agents were launched with a
//     prompt that named no diff file: no path, no `read_file`, no offset. They
//     could not have read the diff, and all 23 made zero tool calls. That is not
//     a whiff, it is a defective launch, and it needs its own name.
//
//   - **Did it work?** Its tool calls are in the record. A whiffing agent leaves
//     zero — and, crucially, its *prose* looks fine: of 129 real transcripts, 80
//     made no tool call at all, and every one of those returned more than 40
//     characters of plausible, specific-sounding text ("No issues found —
//     reviewed chunk 13 (packages/cli/…)"). Any check on the text of a return is
//     blind to this. Only the tool calls see it.
//
// This module never takes a path from the model. The session id and project dir
// come from the environment the CLI itself exported.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One subagent, as the harness recorded it. */
export interface AgentRecord {
  /** `agent-<id>.jsonl`, for messages that have to name a file. */
  file: string;
  agentId: string;
  agentName: string;
  /** The prompt the agent was launched with — the transcript's first record. */
  launchPrompt: string;
  /** Tool calls that came back without an error. */
  successfulToolCalls: number;
  /** Tool calls of any kind, including failed and hallucinated ones. */
  toolCalls: number;
  /** The agent's own final text, as the harness saw it. */
  finalText: string;
  /** When the transcript was last written. */
  mtimeMs: number;
}

/** Why no transcripts could be read. Never conflated with "the agents idled". */
export class TranscriptsUnavailableError extends Error {}

/**
 * Where this session's subagent transcripts live.
 *
 * Both halves come from the environment the CLI exported, never from an argument:
 * a path the model can choose is a path the model can point somewhere flattering.
 * `QWEN_CODE_PROJECT_DIR` exists because the project dir is keyed on the session's
 * *launch* cwd, and this subcommand may well be running inside a PR worktree the
 * skill `cd`-ed into — recomputing it from `process.cwd()` yields a directory that
 * never existed.
 */
export function transcriptDir(env: NodeJS.ProcessEnv = process.env): string {
  const projectDir = env['QWEN_CODE_PROJECT_DIR']?.trim();
  const sessionId = env['QWEN_CODE_SESSION_ID']?.trim();
  if (!projectDir || !sessionId) {
    throw new TranscriptsUnavailableError(
      'the CLI did not export QWEN_CODE_PROJECT_DIR / QWEN_CODE_SESSION_ID, so ' +
        "this run cannot find the harness's record of what its agents did",
    );
  }
  return join(projectDir, 'subagents', sessionId);
}

/** Text out of a record's message parts. */
function textOf(rec: Record<string, unknown>): string {
  const msg = rec['message'] as { parts?: unknown } | undefined;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  return parts
    .map((p) => (p as { text?: unknown }).text)
    .filter((t): t is string => typeof t === 'string')
    .join('');
}

/**
 * Did this tool result come back as an error?
 *
 * The whiff bar is a *successful* call, not any call. The agent runtime writes a
 * `functionCall` record before the permission check and before the tool runs, and
 * it writes one for a hallucinated tool name too. So a single invented or denied
 * call would otherwise clear a bar set at "made a tool call" while having read
 * precisely nothing.
 */
function isErrorResponse(rec: Record<string, unknown>): boolean {
  // Look at the response object itself, not the stringified record. A tool whose
  // *output* happens to contain the text `"error":` — a JSON payload with an
  // `error: null` field, a log line, this very file quoted in a diff — is not a
  // failed call, and treating it as one would mark a working agent idle.
  const msg = rec['message'] as { parts?: unknown } | undefined;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  for (const part of parts) {
    const fr = (part as { functionResponse?: { response?: unknown } })
      .functionResponse;
    if (!fr) continue;
    const resp = fr.response as Record<string, unknown> | undefined;
    if (resp && resp['error'] !== undefined && resp['error'] !== null) {
      return true;
    }
  }
  return false;
}

/** Parse one transcript. Returns null for a file that is not one. */
function parseTranscript(file: string): AgentRecord | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  let agentId = '';
  let agentName = '';
  let launchPrompt = '';
  let finalText = '';
  let toolCalls = 0;
  let successfulToolCalls = 0;
  const pendingCalls: string[] = [];

  for (const line of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // A partial last line: an agent still running. Skip it.
    }
    if (!agentId && typeof rec['agentId'] === 'string')
      agentId = rec['agentId'];
    if (!agentName && typeof rec['agentName'] === 'string') {
      agentName = rec['agentName'];
    }

    const type = rec['type'];
    const body = JSON.stringify(rec['message'] ?? {});

    // The first `user` record is the launch prompt: the harness writes it when it
    // attaches, before the model has produced anything.
    if (!launchPrompt && type === 'user') launchPrompt = textOf(rec);

    if (/"functionCall"/.test(body)) {
      toolCalls++;
      pendingCalls.push('call');
    }
    if (/"functionResponse"/.test(body)) {
      if (!isErrorResponse(rec) && pendingCalls.length > 0) {
        successfulToolCalls++;
      }
      pendingCalls.pop();
    }
    if (type === 'assistant') {
      const t = textOf(rec);
      if (t) finalText = t;
    }
  }

  if (!agentId) return null;

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    /* gone between readdir and stat */
  }

  return {
    file,
    agentId,
    agentName,
    launchPrompt,
    toolCalls,
    successfulToolCalls,
    finalText,
    mtimeMs,
  };
}

/**
 * Every subagent this session launched, as the harness recorded it.
 *
 * `since` drops transcripts older than the plan they are supposed to be evidence
 * for. The transcript dir is scoped to the *session*, not the review, and nothing
 * prunes it — so a second `/review` in one session would otherwise be satisfied
 * by the first one's agents, and the diff path is stable across runs, so the
 * collision is silent. Pass the plan's mtime.
 */
export function readTranscripts(
  since?: number,
  env: NodeJS.ProcessEnv = process.env,
): AgentRecord[] {
  const dir = transcriptDir(env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    // No directory at all is an *infrastructure* fact, not a verdict about the
    // agents. Conflating the two would let a read-only HOME or a full disk read
    // as "every agent idled" and block every review with no diagnosable cause.
    throw new TranscriptsUnavailableError(
      `no subagent transcripts at ${dir} (${(err as Error).message}). The ` +
        'harness writes one per agent; if there are none, either no agents ran ' +
        'or the harness could not write them.',
    );
  }

  const out: AgentRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const rec = parseTranscript(join(dir, name));
    if (!rec) continue;
    if (since !== undefined && rec.mtimeMs < since) continue;
    out.push(rec);
  }
  return out;
}

/**
 * Was this agent given any way to reach the diff?
 *
 * The launch prompt is the harness's record of what the orchestrator actually
 * asked for. A chunk agent whose prompt never names the diff file could not have
 * read it, however confident its answer sounds — and 23 of 23 real ones were
 * launched exactly that way, then said the sentence their prompt had handed them.
 *
 * This is checked against the *prompt*, not the agent's behaviour, because it
 * names the actor that actually failed. "Relaunch the agent" cannot fix a prompt
 * with no diff in it; the second launch is as blind as the first.
 */
export function wasGivenTheDiff(rec: AgentRecord, diffPath: string): boolean {
  const p = rec.launchPrompt;
  if (!p) return false;
  // The diff file, by name. Nothing weaker: a bare `read_file(` in the prompt
  // proves only that *some* file was named, and a prompt that points an agent at
  // source files while never mentioning the diff is exactly as blind as one that
  // names no file at all. It would pass a `read_file`-anywhere check, be called
  // "not blind", and its silence would then be read as a whiff — sending the
  // reader to relaunch an agent whose prompt is the actual defect.
  return p.includes(diffPath);
}
