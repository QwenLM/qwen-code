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

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/**
 * A key as a filename.
 *
 * An invariant agent's key carries the path of the file it owns —
 * `invariant-a--packages/cli/src/x.ts` — and a `/` in a filename is a directory
 * that does not exist. Percent-encoding is reversible, so the reader recovers the
 * key exactly rather than guessing it back from a mangled name.
 */
const fileFor = (key: string) => `${encodeURIComponent(key)}.txt`;

/** Where this agent's brief lives — the file it is told to read first. */
export function briefPath(planPath: string, key: string): string {
  return join(promptRecordDir(planPath), `${encodeURIComponent(key)}.brief.md`);
}

const RULES_MARKER = '## Project rules';

/**
 * Write the brief this agent is told to read.
 *
 * The brief is not in the launch prompt, and that is deliberate. Measured on a real
 * run: asked to paste a 4 652-character prompt to each of twelve agents, the
 * orchestrator delivered 2 893 characters — it kept the head, added a preamble of
 * its own, and **cut 1 900 characters out of the middle**. It will not carry
 * fifty-five kilobytes of instructions across twelve tool calls, and telling it
 * again to do so is the same prose that has failed every time.
 *
 * So the brief goes where the diff already goes: on disk, read by the agent that
 * needs it. What the orchestrator has to carry shrinks to something it will
 * actually carry — and whether the agent read it is then a fact in the harness's
 * transcript, not a hope.
 */
export function writeBrief(
  planPath: string,
  key: string,
  brief: string,
): string {
  const p = briefPath(planPath, key);
  // Refuse the rules downgrade. The launch prompt POINTS at this file and never
  // mentions the rules, so rebuilding a rules-bearing brief without --rules
  // leaves the recorded launch byte-identical: every delivery check keeps
  // passing while the project's review rules silently vanish from the one file
  // the agent treats as authoritative. Reproduced upstream; refused here, at the
  // single choke point both the single-role and roster builds pass through.
  let hadRules = false;
  try {
    hadRules = readFileSync(p, 'utf8').includes(RULES_MARKER);
  } catch {
    // No existing brief — nothing to downgrade.
  }
  if (hadRules && !brief.includes(RULES_MARKER)) {
    throw new Error(
      `agent-prompt: rebuilding "${key}" without --rules would overwrite a ` +
        `rules-bearing brief with a rules-free one, and no delivery check ` +
        `could see it — the launch prompt only points at the brief. Pass the ` +
        `same --rules file as the original build; to intentionally start a ` +
        `rules-free review, delete ${promptRecordDir(planPath)} first.`,
    );
  }
  try {
    mkdirSync(promptRecordDir(planPath), { recursive: true });
    writeFileSync(p, brief);
  } catch {
    // Same reasoning as recordPrompt: a read-only tmp dir fails at the check, where
    // a reader can act on it, not here.
  }
  return p;
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
    writeFileSync(join(dir, fileFor(key)), prompt);
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
    // `.txt` is the launch prompt — the thing the orchestrator must deliver
    // verbatim. `.brief.md` beside it is the agent's own reading, and is not what
    // the delivery check compares against.
    if (!name.endsWith('.txt')) continue;
    try {
      let key: string;
      try {
        key = decodeURIComponent(name.slice(0, -4));
      } catch {
        continue; // Not a name this module wrote.
      }
      out.set(key, readFileSync(join(dir, name), 'utf8'));
    } catch {
      /* raced with a cleanup */
    }
  }
  return out;
}

/**
 * Was `built` delivered to the agent intact?
 *
 * **You may add. You may not remove, alter, or reorder.** Every line the builder
 * emitted has to turn up in the delivered prompt, in the order it was emitted.
 * Anything the caller puts *between* them is its own business.
 *
 * The first version of this was a straight substring test, and it was wrong in a
 * way that would have been worse than no check at all. Dogfooded on a Step 3B
 * review, it failed all nine agents — and both differences were legitimate:
 *
 *   - the caller had inserted **the one-sentence summary of the change that the
 *     skill explicitly tells it to add**, which breaks contiguity by construction;
 *   - and it had reflowed a hard-wrapped sentence onto one line, which changes not
 *     one character of meaning.
 *
 * A gate that fires on a correct run is a gate that gets talked around — this
 * skill has the dogfood transcript of a model doing exactly that, reasoning its way
 * past a refusal it had decided was noise. Precision here is not politeness; it is
 * the difference between a check that works and a check that trains the reader to
 * ignore it.
 *
 * So: normalize whitespace away entirely (a wrap is not an edit), then walk the
 * built lines and require each to appear at or after the last one's position.
 */
export function wasDeliveredVerbatim(
  launchPrompt: string,
  built: string,
): boolean {
  // A zero-byte record is not a prompt, and the loop below would be vacuously true
  // for it — the check would pass every agent, and the roster would credit a role
  // to whichever transcript it happened to look at first. `recordPrompt` swallows
  // its write errors by design (a read-only tmp dir must not stop a review being
  // *built*), so an empty file is exactly what a partial write leaves behind. It is
  // the one input that must fail closed.
  if (built.trim().length === 0) return false;
  const delivered = flatten(launchPrompt);
  let at = 0;
  for (const line of lines(built)) {
    const i = delivered.indexOf(line, at);
    if (i === -1) return false;
    at = i + line.length;
  }
  return true;
}

/** Whitespace collapsed to single spaces: a re-wrap is not an edit. */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The built prompt's lines, whitespace-normalized, blanks dropped. */
function lines(built: string): string[] {
  return built
    .split('\n')
    .map((l) => flatten(l))
    .filter((l) => l.length > 0);
}
