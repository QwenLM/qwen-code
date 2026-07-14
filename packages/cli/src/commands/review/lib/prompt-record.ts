/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// What `agent-prompt` handed out, written down by the thing that handed it out.
//
// `agent-prompt` exists because the orchestrator, told in prose to include the
// diff path in every chunk agent's prompt, did not: 23 of 23 real chunk agents
// were launched with a prompt that named no diff file. So the prompt moved into
// code. Dogfooding the fix, the command was invoked correctly for all five
// chunks — and the orchestrator then **rewrote what it printed** before launching
// the agents. Measured against the harness's transcript of chunk 1, the delivered
// prompt had dropped the instruction not to recite a stock sentence, dropped the
// warning about half-read ranges, and replaced the project's review rules with a
// three-sentence summary of its own. It had also invented an instruction that was
// never in the original.
//
// The prompt was built in code and then edited on the way to the agent, and
// nothing could see it, because the only check on a launch prompt was "does it
// contain the diff path" — and a paraphrase keeps the path.
//
// So the builder now records what it emitted, at a path derived from the plan.
// The caller is never given that path and is never asked to write anything there;
// the check reads it back and compares it to what the harness recorded as the
// agent's actual launch prompt. The two artifacts have different authors, and
// neither is the orchestrator.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';

/**
 * Where the prompts this plan's agents were built from are recorded.
 *
 * Derived from the plan path, by both the writer and the reader, so that neither
 * takes it as an argument. A path the model can choose is a path the model can
 * point somewhere flattering.
 */
export function promptRecordDir(planPath: string): string {
  const p = resolve(planPath);
  return join(dirname(p), `${basename(p).replace(/\.json$/i, '')}-prompts`);
}

/** Record the prompt `key` was built with. Best-effort: never fails a build. */
export function recordPrompt(
  planPath: string,
  key: string,
  prompt: string,
): void {
  try {
    const dir = promptRecordDir(planPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.txt`), prompt);
  } catch {
    // A read-only tmp dir must not stop a review from being *built*. The check
    // that reads these back reports "no prompt was recorded" and fails there,
    // where a reader can act on it, rather than here.
  }
}

/** Every prompt this plan's builder emitted, keyed as it was recorded. */
export function readRecordedPrompts(planPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = promptRecordDir(planPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // Never run, or nothing to record. The caller decides what that means.
  }
  for (const name of names) {
    if (!name.endsWith('.txt')) continue;
    try {
      out.set(name.slice(0, -4), readFileSync(join(dir, name), 'utf8'));
    } catch {
      /* raced with a cleanup */
    }
  }
  return out;
}

/** Drop the record. Called by `cleanup`, which owns the rest of the temp files. */
export function removePromptRecord(planPath: string): void {
  rmSync(promptRecordDir(planPath), { recursive: true, force: true });
}

/**
 * Was `built` delivered to the agent intact?
 *
 * A launch prompt may *wrap* what the builder emitted — a preamble naming the PR
 * is harmless. It may not edit it. So this is containment, not equality, over a
 * whitespace-normalized form: trailing spaces and CRLF are the shell's business,
 * not the reviewer's, and failing a run over them would teach the reader to
 * distrust the check.
 */
export function wasDeliveredVerbatim(
  launchPrompt: string,
  built: string,
): boolean {
  return normalize(launchPrompt).includes(normalize(built));
}

function normalize(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}
