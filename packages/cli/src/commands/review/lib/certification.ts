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
import { briefPath } from './prompt-record.js';

/**
 * An agent's own declaration that its chunk cannot be reviewed. Anchored to a
 * line start so a quotation indented into prose does not match; the chunk
 * number is captured so the veto can stay scoped to the declarer's own
 * territory.
 */
const UNCOVERABLE_RE = /^\s*Uncoverable:\s*chunk\s+(\d+)\b/im;

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
 */
export function declaresOwnUncoverable(
  rec: AgentRecord,
  chunk: number | null,
): boolean {
  if (chunk === null) return false;
  const m = UNCOVERABLE_RE.exec(rec.finalText);
  return m !== null && Number(m[1]) === chunk;
}

/**
 * Does any of these serialized tool-call args name the EXACT `path`? The
 * comparison is against the whole JSON string value (`JSON.stringify(path)`
 * carries the closing quote), so a `${path}.bak` — or any longer path that
 * merely contains this one as a prefix — is NOT credited: the same trap
 * `parseTranscript` avoids for the diff path. This one needle is what the
 * bar's "exact path, not a look-alike" guarantee rests on; every path atom
 * below routes through it, so a fix to the match reaches all of them at once
 * (the drift this module exists to eliminate, applied to its own internals).
 */
function namesPath(args: readonly string[], path: string): boolean {
  const needle = JSON.stringify(path);
  return args.some((a) => a.includes(needle));
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
  return namesPath(rec.successfulCallArgs, briefPath(planPath, key));
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
  return namesPath(rec.successfulReadFileArgs, briefPath(planPath, key));
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
  return namesPath(rec.successfulReadFileArgs, pointer);
}
