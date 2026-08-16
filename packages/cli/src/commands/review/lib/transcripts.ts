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

import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  ToolNames,
  sanitizeFilenameComponent,
} from '@qwen-code/qwen-code-core';
import { join } from 'node:path';
import { priorSessionEntries } from './run-ledger.js';

/** One subagent, as the harness recorded it. */
export interface AgentRecord {
  agentId: string;
  agentName: string;
  /** The prompt the agent was launched with — the transcript's first record. */
  launchPrompt: string;
  /** Tool calls that came back without an error. */
  successfulToolCalls: number;
  /**
   * Successful tool calls whose arguments named the diff file.
   *
   * The difference between this and `successfulToolCalls` is the difference
   * between an agent that did *something* and one that opened *the diff*. The old
   * check could not tell them apart: it credited a chunk to any agent that made
   * one successful call, and a `glob` for test files is a successful call. What a
   * review has to be able to say is that someone opened the lines it is about to
   * certify.
   */
  diffToolCalls: number;
  /**
   * Diff line ranges this agent demonstrably read, 1-based and inclusive.
   *
   * Taken from the `offset`/`limit` of its successful `read_file` calls on the
   * diff. This is what it *did*, next to what it was *told* to do — an agent
   * handed the bare diff path with no territory (a reverse-audit pass, a
   * verifier) can still show which lines it opened.
   */
  diffReads: Array<[number, number]>;
  /**
   * The arguments of every successful tool call, serialized.
   *
   * So a check can ask "did this agent open *that* file" of any path, not only the
   * diff. The one that matters is the agent's own brief: the launch prompt now
   * points at it rather than containing it, and whether the agent read it is a fact
   * the harness wrote down, not a hope.
   */
  successfulCallArgs: string[];
  /**
   * The arguments of the successful `read_file` calls, serialized — a subset of
   * `successfulCallArgs` for the checks where NAMING a path is not OPENING it.
   * A `search_file_content` or a `list_directory` over the record dir carries
   * the same stringified path in its args without reading a line; the
   * findings-file floor asks whether the list was read, and only a read is a
   * read.
   */
  successfulReadFileArgs: string[];
  /**
   * The session the harness stamped on the records, when it stamped one.
   * Compared against the directory that supplied the file: a transcript
   * COPIED into another session's directory is not that session's evidence,
   * and on the resume path a copy could otherwise earn recovered coverage
   * for an attempt that never ran it.
   */
  recordedSession: string;
  /** The agent's own final text, as the harness saw it. */
  finalText: string;
  /**
   * True when `finalText` is a RETURN rather than progress: no tool activity
   * follows it in the transcript. `parseTranscript` keeps the last non-empty
   * assistant text, which includes narration emitted between tool calls — so
   * an agent that opened its inputs, said "reading the diff now…" and died
   * (or is still running) carries non-empty finalText that certifies
   * nothing. The harness appends records in order and writes the final
   * message last, so text with tool traffic after it is progress by
   * construction.
   */
  returned: boolean;
  /** When the transcript was last written. */
  mtimeMs: number;
  /**
   * True when this record came from an EARLIER attempt's session directory —
   * a resumed run reading the interrupted attempt's evidence. Absent on
   * records from the current session, so existing readers are unchanged.
   */
  fromPriorSession?: boolean;
}

/**
 * Why no transcripts could be read. Never conflated with "the agents idled".
 *
 * Carries the underlying readdir failure as `cause` where one exists, so a
 * caller can distinguish "the directory does not exist yet" (ENOENT — the
 * legitimate pre-launch state of a resumed run's own session) from a real
 * infrastructure fault, which must never be absorbed.
 */
export class TranscriptsUnavailableError extends Error {}

/**
 * The environment this module reads, validated once and returned together.
 *
 * Both halves come from the environment the CLI exported, never from an argument:
 * a path the model can choose is a path the model can point somewhere flattering.
 * `QWEN_CODE_PROJECT_DIR` exists because the project dir is keyed on the session's
 * *launch* cwd, and this subcommand may well be running inside a PR worktree the
 * skill `cd`-ed into — recomputing it from `process.cwd()` yields a directory that
 * never existed. Callers that need both halves (the chat file lives beside the
 * subagent dir) take them here rather than re-reading the env after `transcriptDir`
 * validated it.
 */
export function transcriptPaths(env: NodeJS.ProcessEnv = process.env): {
  projectDir: string;
  sessionId: string;
  dir: string;
} {
  const projectDir = env['QWEN_CODE_PROJECT_DIR']?.trim();
  const sessionId = env['QWEN_CODE_SESSION_ID']?.trim();
  if (!projectDir || !sessionId) {
    throw new TranscriptsUnavailableError(
      'the CLI did not export QWEN_CODE_PROJECT_DIR / QWEN_CODE_SESSION_ID, so ' +
        "this run cannot find the harness's record of what its agents did",
    );
  }
  return {
    projectDir,
    sessionId,
    // The harness writes the directory under the SANITIZED id
    // (`getSubagentSessionDir` maps everything outside [A-Za-z0-9_-] to '_'),
    // so the lookup must apply the same mapping: joined raw, any id carrying
    // a dot reaches a path that does not exist, and every reader silently
    // sees nothing while the harness's records sit one underscore away.
    dir: join(projectDir, 'subagents', sanitizeFilenameComponent(sessionId)),
  };
}

/** Where this session's subagent transcripts live. */
export function transcriptDir(env: NodeJS.ProcessEnv = process.env): string {
  return transcriptPaths(env).dir;
}

/** Text out of a record's message parts. */
export function textOf(rec: Record<string, unknown>): string {
  const msg = rec['message'] as { parts?: unknown } | undefined;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  return parts
    .map((p) => (p as { text?: unknown }).text)
    .filter((t): t is string => typeof t === 'string')
    .join('');
}

/**
 * The record's RETURN text: text parts minus thinking. The runtime emits
 * ROUND_TEXT carrying `{text, thought: true}` parts BEFORE the round's tool
 * calls, so a thinking-mode agent killed between the two leaves a complete
 * thought-only record as its last line — and counting thoughts made that
 * internal reasoning the agent's `finalText` with `returned: true`. The
 * runtime's own final-text extraction excludes thoughts; this mirrors it.
 */
function returnTextOf(rec: Record<string, unknown>): string {
  const msg = rec['message'] as { parts?: unknown } | undefined;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  return parts
    .filter((p) => (p as { thought?: unknown }).thought !== true)
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
 *
 * Read the response object itself, not the stringified record. A tool whose
 * *output* happens to contain the text `"error":` — a JSON payload with an
 * `error: null` field, a log line, this very file quoted in a diff — is not a
 * failed call, and treating it as one would mark a working agent idle.
 */
function isErrorPart(part: FunctionResponsePart): boolean {
  const resp = part.functionResponse?.response as
    | Record<string, unknown>
    | undefined;
  return !!resp && resp['error'] !== undefined && resp['error'] !== null;
}

interface FunctionCallPart {
  functionCall?: { id?: unknown; name?: unknown; args?: unknown };
}
interface FunctionResponsePart {
  functionResponse?: { id?: unknown; response?: unknown };
}

/**
 * The diff lines a `read_file` call asked for, 1-based and inclusive.
 *
 * `read_file`'s `offset` is a 0-based line offset. A call with no `limit` asks
 * for as much as one read returns, which is a character budget, not a line count
 * — so it is not a range, and this returns null rather than guessing one. That is
 * deliberate: a guess here would credit a chunk to an agent that read the first
 * screenful of a diff and stopped.
 */
function rangeOf(args: Record<string, unknown>): [number, number] | null {
  const offset = args['offset'];
  const limit = args['limit'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    return null;
  }
  const off =
    typeof offset === 'number' && Number.isInteger(offset) && offset >= 0
      ? offset
      : 0;
  return [off + 1, off + limit];
}

/**
 * Parse one transcript. Returns null for a file that is not one.
 *
 * `diffPath` is what makes a call "a read of the diff" rather than "a call". Pass
 * it and `diffToolCalls` is populated; omit it and the field stays 0.
 */
function parseTranscript(file: string, diffPath?: string): AgentRecord | null {
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
  let recordedSession = '';
  let sessionConflict = false;
  let launchPrompt = '';
  let finalText = '';
  let toolTrafficAfterText = true;
  let successfulToolCalls = 0;
  let diffToolCalls = 0;

  // Calls awaiting their result, carrying what we need from them: did the call
  // name the diff, and over which lines? The harness stamps a matching `id` on
  // both halves, so the pairing is exact rather than positional — a turn that
  // issues three calls at once used to be counted as one, and its results
  // attributed by a stack.
  interface Pending {
    namedTheDiff: boolean;
    readFile: boolean;
    range: [number, number] | null;
    args: string;
  }
  const diffReads: Array<[number, number]> = [];
  const successfulCallArgs: string[] = [];
  const successfulReadFileArgs: string[] = [];
  const byId = new Map<string, Pending>();
  const anonymous: Pending[] = [];

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
    if (typeof rec['sessionId'] === 'string' && rec['sessionId'] !== '') {
      if (!recordedSession) {
        recordedSession = rec['sessionId'];
      } else if (rec['sessionId'] !== recordedSession) {
        // A transcript whose head is stamped with one session and whose tail
        // carries another is a GRAFT: a forged head (the launch prompt is
        // deterministic per plan) spliced onto another session's genuine
        // records would otherwise pass the ownership check, which keys on
        // the first stamp. One file, one session — a conflict rejects the
        // whole record. Unstamped lines stay accepted for older harness
        // writes.
        sessionConflict = true;
      }
    }

    const type = rec['type'];

    // The first `user` record is the launch prompt: the harness writes it when it
    // attaches, before the model has produced anything.
    if (!launchPrompt && type === 'user') launchPrompt = textOf(rec);

    // Read the message PARTS, not a regex over the serialized record. An agent
    // reviewing this module's own diff will have `"functionCall"` and
    // `"functionResponse"` sitting inside a `read_file` result as ordinary text,
    // and a substring match would count that as a tool call the agent never made.
    const msg = rec['message'] as { parts?: unknown } | undefined;
    const parts = Array.isArray(msg?.parts) ? msg.parts : [];

    for (const part of parts) {
      const fc = (part as FunctionCallPart).functionCall;
      if (!fc) continue;
      // Serialize only the ARGUMENTS. The diff path is a path the agent was told
      // to open; a tool *result* that quotes it (a grep over `.qwen/tmp`, this
      // file in a diff) says nothing about what the agent opened.
      const args = (fc.args ?? {}) as Record<string, unknown>;
      // Match the path as a whole JSON string value, quotes included: a bare
      // substring credits `…/diff.txt.bak` for `…/diff.txt`.
      const namedTheDiff = diffPath
        ? JSON.stringify(args).includes(JSON.stringify(diffPath))
        : false;
      const pending: Pending = {
        namedTheDiff,
        readFile: fc.name === ToolNames.READ_FILE,
        range: namedTheDiff ? rangeOf(args) : null,
        args: JSON.stringify(args),
      };
      if (typeof fc.id === 'string' && fc.id) byId.set(fc.id, pending);
      else anonymous.push(pending);
    }

    for (const part of parts) {
      const fr = (part as FunctionResponsePart).functionResponse;
      if (!fr) continue;
      let pending: Pending;
      if (typeof fr.id === 'string' && byId.has(fr.id)) {
        pending = byId.get(fr.id) as Pending;
        byId.delete(fr.id);
      } else if (anonymous.length > 0) {
        // FIFO, not LIFO: a JSONL transcript is chronological, so the oldest
        // un-paired call is the one this earliest un-paired result belongs to.
        pending = anonymous.shift() as Pending;
      } else {
        // A result with no call before it is not evidence of a call.
        continue;
      }
      if (!isErrorPart(part as FunctionResponsePart)) {
        successfulToolCalls++;
        successfulCallArgs.push(pending.args);
        if (pending.readFile) successfulReadFileArgs.push(pending.args);
        if (pending.namedTheDiff) {
          diffToolCalls++;
          if (pending.range) diffReads.push(pending.range);
        }
      }
    }

    if (type === 'assistant') {
      // Thoughts excluded: a thought-only round is not a return, and its
      // reasoning must never be handed downstream as the agent's verdict.
      const t = returnTextOf(rec);
      if (t) {
        finalText = t;
        toolTrafficAfterText = false;
      }
    }
    // Any function call or response AFTER the text marks it as progress —
    // the agent went on working, so that text was narration, not a return.
    if (parts.some((p) => (p as FunctionCallPart).functionCall !== undefined))
      toolTrafficAfterText = true;
    if (
      parts.some(
        (p) => (p as FunctionResponsePart).functionResponse !== undefined,
      )
    )
      toolTrafficAfterText = true;
  }

  if (!agentId) return null;
  if (sessionConflict) return null;

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    /* gone between readdir and stat */
  }

  return {
    agentId,
    agentName,
    recordedSession,
    launchPrompt,
    successfulToolCalls,
    diffToolCalls,
    diffReads,
    successfulCallArgs,
    successfulReadFileArgs,
    finalText,
    returned:
      finalText.trim() !== '' && !toolTrafficAfterText && !diedPerSidecar(file),
    mtimeMs,
  };
}

/**
 * Does the harness's own lifecycle record say this agent never finished?
 *
 * The transcript alone cannot: the harness appends ROUND_TEXT before the
 * round's tool calls and writes NO terminal record on completion, so an
 * agent killed after a text flush and before its next record ends
 * IDENTICALLY to a completed one. The `agent-<id>.meta.json` sidecar is the
 * authoritative signal — a killed agent's persisted status stays 'running'.
 * Any persisted status other than 'completed' (running, paused, failed,
 * cancelled) means the final text is where the agent WAS, not what it
 * concluded. A missing or unreadable sidecar proves nothing and changes
 * nothing: content inference stands, so older harness writes and fixtures
 * without sidecars keep their meaning.
 */
function diedPerSidecar(transcriptFile: string): boolean {
  const metaPath = transcriptFile.replace(/\.jsonl$/, '.meta.json');
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      status?: unknown;
    };
    return typeof meta.status === 'string' && meta.status !== 'completed';
  } catch {
    return false;
  }
}

/**
 * The session's subagent transcript files, one listing every reader shares.
 *
 * The coverage gate and the cost ledger both claim to read "the same records",
 * and the harness writes sibling file kinds per agent (`.meta.json`,
 * `.jsonl.stream`) with a generalized `<kind>-<id>.jsonl` namespace planned —
 * so the definition of "which files are transcripts" lives here, once, not in
 * each reader's own filter. Throws on any readdir failure; what the caller
 * does with that (name the fault, or treat an absent dir as "no agents") is
 * its decision.
 */
export function listAgentTranscriptFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
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
  diffPath?: string,
): AgentRecord[] {
  const dir = transcriptDir(env);
  let names: string[];
  try {
    names = listAgentTranscriptFiles(dir);
  } catch (err) {
    // No directory at all is an *infrastructure* fact, not a verdict about the
    // agents. Conflating the two would let a read-only HOME or a full disk read
    // as "every agent idled" and block every review with no diagnosable cause.
    throw new TranscriptsUnavailableError(
      `no subagent transcripts at ${dir} (${(err as Error).message}). The ` +
        'harness writes one per agent; if there are none, either no agents ran ' +
        'or the harness could not write them.',
      // The original errno travels with it: a caller that tolerates "the dir
      // does not exist yet" must be able to tell that apart from EACCES/EIO,
      // and the flattened message string cannot say which it was.
      { cause: err },
    );
  }

  // The same ownership check the prior directories get. A record stamped
  // with a DIFFERENT session was copied here — `since` cannot catch it (a
  // copy gets a fresh mtime) and the launch-prompt pairing passes (prompts
  // are deterministic per plan) — and a copy is not evidence of THIS
  // session's work any more than it was of the attempt it was planted in.
  return recordsIn(dir, names, since, diffPath, {
    sessionId: transcriptPaths(env).sessionId,
  });
}

/**
 * The files-to-records pipeline, in ONE place.
 *
 * Both readers below walk it — the current session's directory and each
 * prior session's — so a record-level filter or validation added here cannot
 * apply to live evidence while silently bypassing recovered evidence, which
 * is precisely the evidence a fabrication concern is about. The callers keep
 * only the policy that genuinely differs between them: throw versus skip on
 * an unreadable directory.
 */
function recordsIn(
  dir: string,
  names: string[],
  since: number | undefined,
  diffPath: string | undefined,
  opts: { sessionId?: string; until?: number } = {},
): AgentRecord[] {
  const out: AgentRecord[] = [];
  for (const name of names) {
    const rec = parseTranscript(join(dir, name), diffPath);
    if (!rec) continue;
    if (since !== undefined && rec.mtimeMs < since) continue;
    // Each attempt's window closes when the next one opened: a session that
    // kept running after the resume took over is no longer this review's,
    // and its later transcripts must not be credited to it.
    if (opts.until !== undefined && rec.mtimeMs >= opts.until) continue;
    // The record must belong to the directory that supplied it. The harness
    // stamps the session on its records; a file that names a DIFFERENT one
    // was copied there, and a copy is not evidence of the attempt whose
    // directory it sits in. A record with no stamp is accepted — older
    // harness writes carry none — but a mismatch is refused.
    if (
      opts.sessionId !== undefined &&
      rec.recordedSession !== '' &&
      rec.recordedSession.toLowerCase() !== opts.sessionId.toLowerCase()
    ) {
      continue;
    }
    out.push(rec);
  }
  return out;
}

/**
 * The EARLIER sessions of this run, as directories that are actually inside
 * the harness's own tree.
 *
 * The ledger's charset gate keeps an id from traversing out with `..` or a
 * separator, but `subagents/<id>` can itself BE a symlink — and `readdirSync`
 * and `readFileSync` follow one. That would defeat the containment this
 * feature's threat model rests on ("a fabricated id can at most point a
 * reader at a directory inside the harness's own subagents tree"), so a
 * symlinked (or unstattable) prior directory is skipped: invisible evidence
 * re-owes the work, which is the failure direction every reader here takes.
 *
 * Shared by every prior-session consumer — the transcript union and the cost
 * ledger both assemble their paths from this, so the guard cannot be
 * bypassed by a call site that builds its own `join`.
 */
export function priorSessionDirs(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{
  sessionId: string;
  dir: string;
  chatFile: string;
  /** When the NEXT attempt began — this one's upper window. */
  endsAtMs: number | null;
}> {
  const { projectDir } = transcriptPaths(env);
  const out: Array<{
    sessionId: string;
    dir: string;
    chatFile: string;
    endsAtMs: number | null;
  }> = [];
  for (const { sessionId, endsAtMs } of priorSessionEntries(planPath, env)) {
    const dir = join(
      projectDir,
      'subagents',
      sanitizeFilenameComponent(sessionId),
    );
    try {
      if (lstatSync(dir).isSymbolicLink()) continue;
    } catch {
      // Absent (the attempt died before launching any agent) or unstattable:
      // either way there is nothing here this run may read.
      continue;
    }
    out.push({
      sessionId,
      dir,
      chatFile: join(projectDir, 'chats', `${sessionId}.jsonl`),
      endsAtMs,
    });
  }
  return out;
}

/**
 * Every subagent THIS RUN launched, across all of the run's sessions.
 *
 * The single-session `readTranscripts` contract is preserved exactly for the
 * current session: an unreadable current directory is an infrastructure fact
 * and throws. A prior session's directory that cannot be read is different —
 * its absence only means the earlier attempt's evidence is invisible, and the
 * failure direction of invisible evidence is "require the work again", which
 * every downstream gate already implements. So prior directories are skipped
 * silently, never fabricated and never fatal.
 *
 * `since` stays the plan's mtime: a resumed run deliberately does not rewrite
 * the plan, which is what keeps the first attempt's records inside the fence.
 *
 * `currentDirOptional` exists for exactly one caller shape: a resumed run
 * reading the PREVIOUS attempt's evidence before this session has launched
 * any agent — the harness creates `subagents/<session>` on the first launch,
 * so at that moment the current directory legitimately does not exist. It is
 * deliberately narrow on both axes: only ENOENT is absorbed (a permission or
 * I/O fault on an existing directory is a live infrastructure fault), and
 * only when this run actually has prior-session evidence to read instead —
 * a run with no ledger and no directory has shown nothing, which is the
 * infrastructure fact this module has always refused to certify past. A
 * missing ENVIRONMENT (no session id, no project dir) still throws.
 */
export function readRunTranscripts(
  planPath: string,
  since?: number,
  env: NodeJS.ProcessEnv = process.env,
  diffPath?: string,
  opts: { currentDirOptional?: boolean } = {},
): AgentRecord[] {
  // Validates the env first, so the optional-dir branch below can only ever
  // be absorbing "no directory yet", never "no environment".
  transcriptPaths(env);
  const priors = priorSessionDirs(planPath, env);
  let out: AgentRecord[];
  try {
    out = readTranscripts(since, env, diffPath);
  } catch (err) {
    const code = (
      (err as { cause?: NodeJS.ErrnoException } | undefined)?.cause as
        | NodeJS.ErrnoException
        | undefined
    )?.code;
    if (
      !(err instanceof TranscriptsUnavailableError) ||
      opts.currentDirOptional !== true ||
      // ONLY the not-created-yet case. EACCES/EIO/ENOTDIR on an existing
      // directory is a live infrastructure fault: absorbing it would let a
      // run certify on prior-session evidence alone while the current
      // session's records are unreadable and nothing says so.
      code !== 'ENOENT' ||
      // ...and only when there IS prior evidence to read instead. With no
      // ledgered session this is a run that has shown nothing, which every
      // reader here must keep refusing to certify past.
      priors.length === 0
    ) {
      throw err;
    }
    out = [];
  }
  for (const prior of priors) {
    let names: string[];
    try {
      names = listAgentTranscriptFiles(prior.dir);
    } catch {
      continue; // Earlier attempt's evidence invisible → its work is re-owed.
    }
    for (const rec of recordsIn(prior.dir, names, since, diffPath, {
      sessionId: prior.sessionId,
      until: prior.endsAtMs ?? undefined,
    })) {
      rec.fromPriorSession = true;
      out.push(rec);
    }
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
