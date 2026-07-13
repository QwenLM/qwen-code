/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Coverage, computed from the harness's records rather than accepted from the
// caller.
//
// This is shared by `check-coverage` (which stops the run) and `compose-review`
// (which caps the verdict) deliberately. The old shape had `check-coverage` write
// a report and `compose-review` take a `coverage` **field in a JSON the model
// writes** — so hardening the first while the second still believed a hand-typed
// `{"ok": true}` would have moved the forgery one hop downstream and made it
// cheaper: one object instead of eighteen fabricated receipts. A caller cannot
// forge what it cannot supply, so neither of them is given the answer. They both
// derive it.

import { readFileSync, statSync } from 'node:fs';
import {
  readTranscripts,
  wasGivenTheDiff,
  TranscriptsUnavailableError,
  type AgentRecord,
} from './transcripts.js';

export interface CoverageFromTranscripts {
  /** True only when every chunk was reviewed by an agent that could and did. */
  ok: boolean;
  /** How many subagent transcripts the harness wrote for this run. */
  agents: number;
  /**
   * Chunk agents launched with a prompt that never named the diff.
   *
   * They cannot have read it. This is not a whiff and must not be reported as
   * one: relaunching an agent whose prompt has no diff in it produces a second
   * agent that also cannot read the diff. The prompt is the defect.
   */
  blindAgents: string[];
  /** Agents that made no successful tool call: they read nothing. */
  idleAgents: string[];
  /** Chunk ids no working agent covered. */
  missingChunks: number[];
  /** Chunk ids an agent declared unreachable. */
  uncoverableChunks: number[];
  /** Chunk ids a working agent actually reviewed. */
  coveredChunks: number[];
}

/** The plan, as far as coverage needs it. */
interface Plan {
  diffPathAbsolute: string;
  chunks: Array<{ id: number; startLine: number; endLine: number }>;
}

function readPlan(path: string): { plan: Plan; mtimeMs: number } {
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan;
  if (typeof plan?.diffPathAbsolute !== 'string' || !plan.diffPathAbsolute) {
    throw new Error(`coverage: ${path} has no diffPathAbsolute`);
  }
  if (!Array.isArray(plan.chunks) || plan.chunks.length === 0) {
    throw new Error(`coverage: ${path} has no chunks[]`);
  }
  return { plan, mtimeMs: statSync(path).mtimeMs };
}

/** `chunk 13 of 25` — written into the prompt by `agent-prompt`, in code. */
const CHUNK_RE = /\bchunk\s+(\d+)\s+of\s+\d+\b/i;

/** The chunk this agent was launched to review, from the harness's own record. */
function assignedChunk(rec: AgentRecord): number | null {
  const m = CHUNK_RE.exec(rec.launchPrompt);
  return m ? Number(m[1]) : null;
}

const UNCOVERABLE_RE = /^\s*Uncoverable:\s*chunk\s+(\d+)\b/im;

/**
 * What the agents of this run actually did, as the harness recorded it.
 *
 * Nothing here is supplied by the caller except the plan path. The transcripts
 * are found from the environment the CLI exported; their contents are the
 * harness's, written at launch and flushed per event.
 *
 * Transcripts older than the plan are ignored. The transcript directory is scoped
 * to the session, not the review, and nothing prunes it — so a second `/review`
 * in one session would otherwise be satisfied by the first one's agents. The diff
 * path is stable across runs, which makes that collision silent.
 */
export function coverageFromTranscripts(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): CoverageFromTranscripts {
  const { plan, mtimeMs } = readPlan(planPath);
  const records = readTranscripts(mtimeMs, env);

  const blindAgents: string[] = [];
  const idleAgents: string[] = [];
  const covered = new Set<number>();
  const uncoverable = new Set<number>();

  for (const rec of records) {
    const chunk = assignedChunk(rec);
    const label =
      chunk !== null ? `chunk ${chunk}` : rec.agentName || rec.agentId;

    // Could this agent have read the diff at all? The prompt is the harness's
    // record of what was asked of it. 23 of 23 real chunk agents were launched
    // without one, and every one of them then said the sentence its prompt had
    // handed it.
    if (chunk !== null && !wasGivenTheDiff(rec, plan.diffPathAbsolute)) {
      blindAgents.push(label);
      continue; // Its silence proves nothing about the diff; the prompt failed.
    }

    const u = UNCOVERABLE_RE.exec(rec.finalText);
    if (u && chunk !== null && Number(u[1]) === chunk) {
      uncoverable.add(chunk);
      continue;
    }

    // Did it work? Zero successful tool calls means it read nothing — whatever
    // its prose says. Of 129 real transcripts, 80 made no call and every one of
    // them returned more than forty characters of confident, specific text.
    if (rec.successfulToolCalls === 0) {
      idleAgents.push(label);
      continue;
    }

    if (chunk !== null) covered.add(chunk);
  }

  const planned = plan.chunks.map((c) => c.id);
  const missingChunks = planned.filter(
    (id) => !covered.has(id) && !uncoverable.has(id),
  );

  return {
    ok:
      blindAgents.length === 0 &&
      idleAgents.length === 0 &&
      missingChunks.length === 0,
    agents: records.length,
    blindAgents,
    idleAgents,
    missingChunks,
    uncoverableChunks: [...uncoverable].sort((a, b) => a - b),
    coveredChunks: [...covered].sort((a, b) => a - b),
  };
}

export { TranscriptsUnavailableError };
