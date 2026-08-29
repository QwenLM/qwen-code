/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The atoms of the certification bar, defined once.
 *
 * Every consumer that decides whether a transcript's agent did the work it
 * was launched for — the coverage walk, its supersession predicates, the
 * recovered-work counter, the layer-audit gate, retirement's pairing, and
 * `recover-findings`' recovery bar — asks some conjunction of the same five
 * questions: did it return, did it disown its own territory, did it open its
 * brief, did it read the findings list its prompt names, which chunk was it
 * assigned. Five review rounds found five places where a re-implemented copy
 * of one of these atoms drifted from the original; this module exists so
 * there is nothing left to drift. Compositions still differ per consumer —
 * that is their job — and the `returned` question stays a plain field read
 * (`rec.returned`) at each site rather than an atom here; every OTHER atom
 * has exactly one definition below.
 */

import type { AgentRecord } from './transcripts.js';
import { serializedArgsNamePath } from './transcripts.js';
import { briefPath } from './prompt-record.js';

/**
 * An agent's own declaration that its chunk cannot be reviewed. Anchored to a
 * line start so a quotation mid-line in prose cannot match; leading
 * whitespace stays admitted because the brief template renders the line
 * indented and an honest declarer may reproduce it that way — which an
 * indented QUOTATION on its own line also matches, so consumers adjudicate
 * the candidates rather than trusting any single match. The chunk number is
 * captured so the veto can stay scoped to the declarer's own territory.
 */
const UNCOVERABLE_RE = /^\s*Uncoverable:\s*chunk\s+(\d+)\b/gim;

/**
 * The chunk a KEY assigns: `chunk-13` → 13, and the per-chunk audit shapes —
 * `reverse-audit--chunk-13--round-2--<digest>` — carry theirs in a
 * `--chunk-N` segment. Parsing only the bare form left those keys
 * chunk-less, and with the production launch prompt carrying no
 * `chunk N of M` line either, the bar's diff-read requirement silently
 * vanished for exactly the auditors whose territory is a chunk.
 */
export function chunkOfKey(key: string): number | null {
  const m = /^chunk-(\d+)$/.exec(key) ?? /--chunk-(\d+)(?:--|$)/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * Does this record's own return declare ITS OWN chunk unreachable? The veto
 * is chunk-SCOPED: applied raw, the regex also matches a QUOTATION, and
 * quoting the evidence verbatim is exactly what a reverse-audit brief
 * instructs — a whole-diff record quoting a declaration is not declaring.
 * EVERY match is read, not only the first: a declarer that quotes another
 * chunk's declaration ahead of its own line still declares its own chunk
 * (R22-2).
 */
export function declaresOwnUncoverable(
  rec: AgentRecord,
  chunk: number | null,
): boolean {
  if (chunk === null) return false;
  return declaredUncoverableChunkIds(rec).includes(chunk);
}

/**
 * The chunk ids a record's return declares uncoverable, in text order,
 * whatever chunk the record was ASSIGNED. Every match, not only the first:
 * an earlier quotation of another chunk's declaration must not hide the
 * record's own declaration — the walk adjudicates each candidate against
 * its shape gates (R22-2). A paraphrased launch breaks the anchored
 * identity line and de-assigns the record, but the declaration line
 * survives — the coverage walk reads the id off it so the declaration is
 * sealed and ruled on instead of dropped (R17-4). The quotation caveat
 * rides the walk's seals there, not this atom: an id read off a return is
 * a claim, and the walk decides what proves it.
 */
export function declaredUncoverableChunkIds(rec: AgentRecord): number[] {
  return [...rec.finalText.matchAll(UNCOVERABLE_RE)].map((m) => Number(m[1]));
}

/**
 * Does ANY of these serialized tool-call args name the EXACT `path`?
 *
 * The match itself lives in `transcripts.ts` beside the code that serializes
 * the args, and `parseTranscript`'s diff-read half calls the same function —
 * so the bar's "exact path, not a look-alike" guarantee has ONE definition,
 * not one per half. This wrapper only spreads it over a record's call list;
 * every path atom below routes through it.
 *
 * The name is deliberately not `namesPath`: `findings.ts` has a
 * module-private `namesPath` that matches a path named in PROSE on a name
 * boundary — it credits `rm /plan/chunk-3.brief.md` for naming the brief.
 * Unifying these two would make `openedBrief` credit an agent for deleting a
 * file it never opened, so they keep distinct names to stop a future reader
 * treating either as THE path matcher.
 */
function argsNameExactPath(args: readonly string[], path: string): boolean {
  return args.some((a) => serializedArgsNamePath(a, path));
}

/**
 * Did this record's agent open the brief recorded under `key`? Compared as a
 * whole JSON string value (`successfulCallArgs` are serialized args), so a
 * `${brief}.bak` cannot be credited for the brief. "Open" is mention-level:
 * any successful tool whose args name the exact path.
 */
export function openedBrief(
  rec: AgentRecord,
  planPath: string,
  key: string,
): boolean {
  return argsNameExactPath(rec.successfulCallArgs, briefPath(planPath, key));
}

/**
 * Did this record's agent READ the brief recorded under `key`? Stricter than
 * `openedBrief`: only a successful `read_file` of the exact path counts — a
 * grep or listing whose args merely CONTAIN the brief path named it without
 * opening a line of it. The layer-audit gate's bar.
 */
export function readBrief(
  rec: AgentRecord,
  planPath: string,
  key: string,
): boolean {
  return argsNameExactPath(
    rec.successfulReadFileArgs,
    briefPath(planPath, key),
  );
}

/**
 * Did this record's agent successfully `read_file` the findings pointer its
 * prompt names? True when the prompt names none. Successful read_file calls
 * ONLY: every tool serializes its args, and a `search_file_content` or a
 * `list_directory` over the record dir names the path without reading a line
 * of it — the floor certifies that the list was OPENED, and a mention is not
 * an open.
 */
export function readFindingsPointer(
  rec: AgentRecord,
  pointer: string | null,
): boolean {
  if (pointer === null) return true;
  return argsNameExactPath(rec.successfulReadFileArgs, pointer);
}
