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
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { writeStderrLineSafe } from '../../../utils/stdioHelpers.js';

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

/** Where a round's findings list lives — the file the launch block points at. */
export function findingsFilePath(planPath: string, key: string): string {
  return join(
    promptRecordDir(planPath),
    `${encodeURIComponent(key)}.findings.md`,
  );
}

/**
 * The findings file a recorded launch prompt points at, if any — the pointer
 * `findingsSection` bakes into the block. Anchored to the exact shape that
 * builder emits: the pointer sits alone on its own line inside its fence.
 * The anchor matters because of the write-failure fallback: when the findings
 * file could not be written, `findingsSection` inlines the LIST in that same
 * position, and a finding entry there can itself quote a
 * `read_file(file_path="….findings.md")` line. A loose first-match would then
 * extract the QUOTATION as the pointer — and the readers diverge: coverage
 * demands a read of a path no agent was told to read (spurious
 * `findings-unread` on an already-degraded run), and retirement, worse,
 * confines-and-reads an earlier round's file, flipping `yielded` to dry and
 * retiring a chunk that just reported — the one direction this module's
 * header says it never fails. A quoted pointer inside a findings entry is
 * indented or embedded in prose, so requiring it standalone removes it. A
 * brief path (`.brief.md`) can never match the `.findings.md` suffix.
 * Shared by every reader of the pointer: the delivery floor (coverage) and
 * the retirement echo-guard both extract it from the recorded prompt rather
 * than deriving a path from the record key — a per-chunk record key and its
 * round's findings file are keyed differently, so the prompt is the only
 * source that is always right.
 */
export function findingsPointerOf(prompt: string): string | null {
  const m = /^read_file\(file_path="([^"]*\.findings\.md)"\)$/m.exec(prompt);
  return m && m[1] !== undefined ? m[1] : null;
}

/**
 * Write the findings list a verify/reverse-audit launch block points at.
 *
 * The list used to be folded verbatim into every printed block — the point was
 * a record a partial delivery cannot satisfy, and inlining made the findings
 * part of the recorded prompt. On a 12-14-chunk round that made the orchestrator
 * re-emit 65-82 KB in ONE assistant message, and the stream generating that
 * message never completed (issue #8597). So the list goes where the brief already
 * goes: on disk, named by the same digest that keys the record, read by the
 * agent. The block carries the pointer; dropping it mismatches the recorded
 * prompt exactly as dropping the list did, and the delivery floor counts the
 * read it instructs exactly as it counts the brief's — an agent that opens
 * its brief but skips this file does not clear it.
 *
 * Returns null when the write fails (a read-only tmp dir): the caller then
 * inlines the list into the block — the pre-#8597 shape — instead of
 * pointing a whole round at a file that does not exist.
 */
export function writeFindingsFile(
  planPath: string,
  key: string,
  content: string,
): string | null {
  const p = findingsFilePath(planPath, key);
  try {
    mkdirSync(promptRecordDir(planPath), { recursive: true });
    writeFileSync(p, content);
  } catch (err) {
    // A read-only tmp dir must not stop a review being BUILT — and it must
    // not send a whole round pointing at a file that does not exist either:
    // null makes findingsSection inline the list (the pre-#8597 shape), so
    // the agents read what they were launched with, instead of 12-14 of
    // them burning a full round against a dead path before the delivery
    // floor fails it. Say so now: a silent miss used to leave the round
    // pointing at nothing with no notice anywhere. Safe writer: this catch
    // exists to keep the build alive, so the diagnostic must not throw out
    // of it on EPIPE (`qwen … | head`).
    writeStderrLineSafe(
      `agent-prompt: failed to write findings file ${p}: ` +
        `${(err as Error).message} — inlining the list instead`,
    );
    return null;
  }
  return p;
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

/**
 * Every prompt this plan's builder emitted, keyed as it was recorded.
 *
 * `sinceMs` is the same fence every other reader of this directory applies —
 * the plan's mtime. Nothing clears the record dir, and a run that dies
 * mid-review leaves its records beside the retry's (the CI retry re-runs the
 * review at the SAME plan path, under a freshly-captured plan): a record file
 * older than the plan belongs to that dead attempt. A caller that reads
 * records as OBLIGATIONS (coverage: "an agent was owed for this key") passes
 * nothing — an obligation is not less owed for being stale, and dropping one
 * would excuse the agent it demands. A caller that reads them as HISTORY
 * (retirement) must pass the fence, or the dead attempt's records shadow the
 * live ones.
 */
export function readRecordedPrompts(
  planPath: string,
  sinceMs?: number,
): Map<string, string> {
  const out = new Map<string, string>();
  const dir = promptRecordDir(planPath);
  let names: string[];
  try {
    // Sorted: this module reasons per-record and pairs records against
    // transcripts, and a filesystem-order walk (`readdir` is filename-hash
    // order on ext4, not insertion order) makes the analysis order-sensitive —
    // e.g. which record's state poisons a shared cache first. A deterministic
    // walk removes that whole class.
    names = readdirSync(dir).sort();
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
      const file = join(dir, name);
      if (sinceMs !== undefined && statSync(file).mtimeMs < sinceMs) continue;
      out.set(key, readFileSync(file, 'utf8'));
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
  return deliveredVerbatim(flattenPrompt(launchPrompt), built);
}

/**
 * `wasDeliveredVerbatim` with the launch prompt already put through
 * `flattenPrompt`. The family exists for the one caller that pairs MANY
 * records against MANY transcripts (the retirement scheduler): flattening is
 * the expensive half of the check, and a caller that flattens each launch
 * once pays it per transcript instead of per (record, transcript) pair — a
 * few thousand full-prompt passes on the run the scheduler was built for,
 * all before the round is admitted. Same contract, same failure modes.
 */
export function deliveredVerbatim(
  flattenedLaunch: string,
  built: string,
): boolean {
  if (built.trim().length === 0) return false;
  return deliveredVerbatimLines(flattenedLaunch, promptLines(built));
}

/**
 * `deliveredVerbatim` with BOTH halves pre-flattened: the launch through
 * `flattenPrompt`, the built prompt through `promptLines`. The scheduler
 * hoists each record's `promptLines` alongside each transcript's flatten, so
 * the pairing walk re-splits neither side — on the 6-chunk x 4-prior-round
 * shape the old per-pair record flatten re-split every record's whole folded
 * prompt (cumulative findings list included) once per candidate.
 */
export function deliveredVerbatimLines(
  flattenedLaunch: string,
  builtLines: string[],
): boolean {
  // A zero-byte record is not a prompt, and the loop below would be vacuously
  // true for it (no lines) — the check would pass every agent, and the roster
  // would credit a role to whichever transcript it happened to look at first.
  // `recordPrompt` swallows its write errors by design (a read-only tmp dir
  // must not stop a review being *built*), so an empty file is exactly what a
  // partial write leaves behind. It is the one input that must fail closed.
  if (builtLines.length === 0) return false;
  let at = 0;
  for (const line of builtLines) {
    const i = flattenedLaunch.indexOf(line, at);
    if (i === -1) return false;
    at = i + line.length;
  }
  return true;
}

/**
 * Whitespace collapsed to single spaces: a re-wrap is not an edit. What
 * `deliveredVerbatim` expects its launch side to have been put through.
 */
export function flattenPrompt(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The built prompt's lines, whitespace-normalized, blanks dropped. */
export function promptLines(built: string): string[] {
  return built
    .split('\n')
    .map((l) => flattenPrompt(l))
    .filter((l) => l.length > 0);
}
