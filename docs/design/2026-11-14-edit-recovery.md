# Reduce edit recovery reads and repeated old text

[English](2026-11-14-edit-recovery.md) | [简体中文](2026-11-14-edit-recovery.zh-CN.md)

Status: implemented in this change, 2026-11-14, based on `114694062b8`. The investigation below used Qwen Code `7fab512f79d9ed24e9bc30b5d04b1f5f1267c295`; dsh-better-edit inspection is pinned to v1.2.1, `009b922d591d93dd7d311fc5412717678d24ed3f`. Section 10 records the implemented scope and regression evidence; proposed rollout targets remain unmeasured.

## 1. Problem and evidence

[Issue #14979](https://github.com/QwenLM/qwen-code/issues/14979) describes expensive recovery after failed edits: rereading content, retranscribing `old_string`, and sometimes regenerating the replacement too. A read-only DataAgent audit covering 2026-11-07 00:00 through 2026-11-14 10:35, Asia/Shanghai, confirms this pattern. Counts use distinct session/call IDs and the production environment tag, excluding automatic-memory tasks, other memory files and missing paths. These are accessible DataAgent deployments, not the entire Qwen Code population; deployment tags are not independent proof of environment correctness.

| Observation                                                                                                                                                                         | Implication                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 263 no-match failures in 26,389 non-memory-file edits, approximately 1.00%                                                                                                          | Optimize recovery without making every existing edit use a new protocol immediately.                                                                                                                                                                                                 |
| 1,395 stale-read failures in the same population                                                                                                                                    | No-match and stale-read recovery both matter; their causes must remain distinguishable.                                                                                                                                                                                              |
| SQL case: failed old/new text contained 5,063 / 7,226 characters; old text omitted `d.` already present in an earlier read                                                          | This is a transcription error, not evidence that the matcher rejected correct input.                                                                                                                                                                                                 |
| The SQL retry followed a 60-line read returning 5,113 characters; the next model request took 43.003 seconds and emitted 3,781 output tokens; failure-to-success was 46.730 seconds | The expensive part is model/tool-loop recovery; the failed tool itself took 47 ms.                                                                                                                                                                                                   |
| Successful retry old/new text contained 5,065 / 7,141 characters                                                                                                                    | A reference could remove the 5,065-character old-text emission, about 41.5% of these two text fields. This is a character-based counterfactual, not a measured token or latency improvement. The replacement changed too, so reusing the original replacement is not proven correct. |
| Report case: a 4,013-character no-match led to grep, shell extraction and shell rewriting; a later stale edit repeated identical 350 / 966-character arguments after another read   | Recovery should keep the model within edit and allow explicit reuse of an unchanged replacement. The later stale check is consistent with the same session's shell write.                                                                                                            |

The report case's initial discrepancy is supported by reconstructing previous writes, not by a disk snapshot taken at failure. Neither case establishes the issue's specific 800-line/20k-token example or edit-induced compaction. Raw conversations and tenant/session identifiers stay outside this tracked design.

The goal is to reduce extra recovery calls and repeated model output while preserving explicit target selection, current-content checks, permissions and reviewable diffs. Reducing the observed rejection rate by accepting uncertain writes is not a success metric.

## 2. What to borrow from dsh-better-edit

The inspected [tool schema](https://github.com/Rianico/dsh-better-edit/blob/009b922d591d93dd7d311fc5412717678d24ed3f/src/tool-edit.ts) uses `{file, edits: [{anchor_from, anchor_to, replace_with}]}`. Legacy spellings and tuples are accepted by its contract normalizer. Some README examples and the benchmark still describe older shapes.

| Mechanism                                                                | Assessment for Qwen Code                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three-character line anchors replace old-text transcription              | Adopt the principle of host-resolved references. New replacement text still costs output tokens.                                                                                                                                        |
| Session-scoped served state, snapshots, leases and line identities       | The short hash alone is insufficient. References need ownership, exact content evidence and invalidation.                                                                                                                               |
| Rejection returns current target rows when the target can be established | Adopt bounded recovery content. Lost targets, truncated windows and ambiguous identity can still require a read.                                                                                                                        |
| Successful diffs provide new anchors                                     | Later, make fully delivered success snippets usable as fresh references. Qwen already returns success snippets, but without this addressing contract.                                                                                   |
| Identity-based relocation after exterior changes                         | Defer. It requires duplicate-line and deleted-twin handling; it is not equivalent to searching for the same text elsewhere.                                                                                                             |
| ASCII-whitespace-insensitive canonicalization                            | Do not adopt as write authorization. The implementation removes spaces and tabs even inside strings and indentation. Its ADR explicitly assumes formatter-only external changes; the issue describes human and other-agent changes too. |

The [canonicalizer](https://github.com/Rianico/dsh-better-edit/blob/009b922d591d93dd7d311fc5412717678d24ed3f/src/hashline/hash-assign.ts#L105-L115) and [whitespace ADR](https://github.com/Rianico/dsh-better-edit/blob/009b922d591d93dd7d311fc5412717678d24ed3f/docs/adr/0002-whitespace-insensitive-anchors.md) make that last limitation concrete: `"x y"` and `"xy"` canonicalize identically. Canonical equality is not semantic equality. The [served-range implementation](https://github.com/Rianico/dsh-better-edit/blob/009b922d591d93dd7d311fc5412717678d24ed3f/src/hashline/anchor-pipeline.ts) also has a leased route that permits unread interior holes between verified boundaries. Qwen's proposed first version instead requires the entire replacement target to have been delivered.

The project's [benchmark](https://github.com/Rianico/dsh-better-edit/blob/009b922d591d93dd7d311fc5412717678d24ed3f/benchmark/README.md) reports 702 versus 1,015 request-payload tokens for 12 scripted replacements in a 103-line fixture, approximately 31% less. It excludes reads and transcription failures, uses `cl100k_base`, and its [script](https://github.com/Rianico/dsh-better-edit/blob/009b922d591d93dd7d311fc5412717678d24ed3f/benchmark/run.mjs#L279-L296) constructs the old single-edit envelope rather than the current named-object envelope. The README's 40–60% and single-run 55.8% figures are not a Qwen production comparison. No independent reproduction of those benchmarks is claimed here.

## 3. Delivery order

| Stage                    | Change                                                                      | Expected benefit                                                                      | Boundary                                                                            |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P0: informative failures | Return a bounded current candidate, mismatch detail and precise next action | Avoid a separate localization/read roundtrip where the returned content is sufficient | Still requires ordinary old/new arguments; does not solve retranscription by itself |
| P1: recovery references  | Add an explicit `recovery_id` form to the existing edit tool                | Omit old text on retry; optionally reuse the failed replacement                       | Snapshot-bound, one target, same session/runtime, no automatic fuzzy write          |
| P2: read references      | Let a fully delivered read range be selected by reference plus line bounds  | Avoid old-text generation on the first attempt, including successful edits            | Opt-in after P1 validation; no global hashline migration                            |

P0 and P1 are the recommended first delivery sequence. Stopping after P0 would leave the user's old-string output cost substantially intact. Batching, persistent line lineage, automatic relocation and generalized undo are separate follow-ups, not prerequisites.

## 4. P0: return useful current content

Enrich `EDIT_NO_OCCURRENCE_FOUND` and `file_changed_since_read`. Keep permission denials, unread-file errors, missing files and unsupported formats distinct; they must not silently turn into authorized reads. Disclosing current content requires the equivalent Read permission on both failure paths, even when edit already loaded that content internally. If it is not permitted, keep the diagnostic without the content or a reference.

For no-match, use the already admitted current content where available. Add a bounded candidate locator using surviving context lines and line alignment. It only produces suggestions. The existing `findLineBasedMatchOffsets` locates an already-matched substring; it is not a nearest-candidate search, and `extractEditSnippet` alone cannot supply one.

For stale reads, obtain a fresh observation only after the equivalent Read permission check succeeds. A unique exact occurrence of the submitted old text can identify a current candidate. Otherwise use the same diagnostic locator or return a precise read instruction. `FileReadCache` stores metadata, not prior text; therefore the tool cannot promise to show an actual before/after external-change diff without a retained snapshot.

Return the error class, path, candidate line boundaries, the first useful mismatch, and clearly delimited current content. Do not echo the entire failed old/new request. Candidate similarity is guidance, never permission to write. Up to three concise candidate locations may be listed; the first version offers an executable recovery reference only for a single conservatively identified target whose complete content is included.

Initial proposed limits are 120 lines and 16 KiB of UTF-8 recovery content, including any surrounding context. Both limits apply. Never substitute an ellipsis for unseen target text and then issue a reference covering it. If the whole target cannot fit, provide a narrower `read_file(offset, limit)` instruction and do not issue a writable reference. These are implementation starting bounds to validate against the model's output budget, not measured optimum values.

The content moves into the failure response; its input-token cost does not disappear. The saving is the additional model/tool roundtrip and avoidable repeated reads. P0 must not call `recordRead` merely because a snippet was constructed: doing so would refresh file-wide Edit/WriteFile permission state beyond what the model saw. P0 alone cannot bypass the stale-read guard.

## 5. P1: explicitly retry by reference

Keep the existing `{file_path, old_string, new_string, replace_all?}` form. Add a mutually exclusive form:

```json
{
  "file_path": "/workspace/report.md",
  "recovery_id": "er_7Kq"
}
```

The model explicitly selects the complete current candidate returned with `er_7Kq`. Omitting `new_string` means reuse the replacement from the failed call. Supplying `new_string` replaces that saved proposal. No `old_string` is required. An empty supplied replacement still means deletion. The example identifier is illustrative; actual identifiers must be opaque and scoped, not three-character content hashes.

The model must review the returned candidate and mismatch before choosing this form. For the SQL case, overriding `new_string` remains available because the recorded successful replacement differed from the failed one. This mechanism does not infer that a nearly matching target makes the old proposal correct.

### State and validity

Use a small, in-memory store owned by the file-executing session/runtime. Each entry binds workspace and canonical path/file identity, an exact current-file content digest, the exact candidate range and raw old text, the failed replacement, and the originating call. Preserve existing encoding, BOM and line-ending behavior. Do not persist a new snapshot database or put tenant content in telemetry.

Bound the initial store to eight references and 1 MiB of retained text per session. Evict older entries or omit the reference when a request exceeds the budget; ordinary edit remains available. No `replace_all`, ambiguous-target selection, reference transfer across sessions, or automatic rebasing is included in P1. Require the nonempty raw target to have exactly one literal occurrence in the current file, even if the diagnostic locator prefers one of several similar locations. The reference route must not fall back to fuzzy matching.

A reference is consumed on successful writing. It becomes unusable after snapshot change, session/runtime/workspace switch, restart, resume or removal of its evidence from model history. Clear the store on full or micro compaction for the first version. Cancellation or result suppression must not leave an actionable reference. After another content change, reject and return fresh recovery information where authorized; do not silently relocate or approve the old proposal.

### Permissions and confirmation

Resolve the reference into equivalent actual file/old/new parameters **before** PreToolUse, permission handling and AUTO classification. Resolving only during `execute`, or even only during tool build, is too late: hooks currently run before build. Preserve the original wire arguments separately for accounting without reinjecting expanded text into the model transcript.

Human confirmation receives the real current-to-proposed diff. AUTO classification receives the same content projection as a conventional edit. A reference is not inherited approval. Hook input replacements, PermissionRequest updates and IDE modify-and-confirm must be revalidated; if a target or old-text change breaks the binding, discard the recovery authority and use the normal read/edit path. A replacement-text change must become the actual proposal reviewed and written, never be overwritten by the saved value.

Use invocation-scoped read evidence for this exact target and snapshot. Do not refresh global `FileReadCache` state to make the retry pass. Carry the binding through confirmation, execution and the last pre-write check; another read refreshing the shared cache cannot validate an old recovery snapshot. Recheck exact content and file identity, not only mtime and size. Retain existing backup and write semantics. These checks do not create a filesystem-level atomic compare-and-swap guarantee against arbitrary external writers.

### Delivery and truncation

Use the existing `ToolResult.recoveryText` mechanism to keep the complete bounded target, mismatch explanation and reference in one indivisible block. The invariant applies at the final model-send boundary, after result hooks and batch budgeting: never retain the ID while dropping part of its target. If a path cannot guarantee this, omit the reference and return diagnostic-only recovery. Compaction needed to make space must invalidate old evidence, with new references issued only for content retained in the outgoing result.

Prepare inactive recovery state with the result; activate it only when its complete block is included in the next model request. If compaction occurs first, discard old entries and issue a fresh reference in the retained outgoing block. If that final-delivery handoff cannot be implemented on a route, keep P0 only on that route.

Cover both execution errors and confirmation-time `StructuredToolError`; either can be the model's only failure response. Remote result forwarding currently omits `recoveryText`, and confirmation errors do not carry it. Both gaps must be handled before enabling references on those routes. Merely constructing a producer result is not proof that the model received it.

## 6. P2: avoid the first old-string transcription

After P1 is validated, let `read_file` return an opaque `read_id` for fully delivered raw text ranges. The edit form selects lines in that snapshot:

```json
{
  "file_path": "/workspace/query.sql",
  "read_id": "rd_9M",
  "start_line": 140,
  "end_line": 190,
  "new_string": "replacement text"
}
```

Line bounds are inclusive, refer to the referenced snapshot, and must lie entirely within fully delivered coverage. They are not unversioned current-file coordinates. Define whole-line replacement and final-line/EOL behavior explicitly; partial-line edits retain the conventional string form initially. Any file change invalidates the first version's reference. Do not automatically search for a byte-identical range elsewhere. Unlike P1's unique-literal target, P2 must apply exactly the selected range after snapshot validation; materializing old/new for review must not turn a range edit into a global substring search when identical blocks exist.

Bind references to raw source ranges, not rendered text. Current reads trim trailing whitespace for display and may truncate within a line. Reference-bearing output must preserve the underlying line text rather than reuse that lossy rendering; a truncated line must not receive a writable reference. The final delivery rule from P1 applies to reads and success snippets too. A successful edit may provide a fresh reference only for the complete region actually returned; old snapshot references remain invalid.

P2 removes old-text output on initial edits, but replacement text is still necessary. It should be compared against P1 and the conventional tool before changing the default schema or read presentation for every provider. Consider identity-based relocation only if residual exterior-drift recovery remains costly enough to justify its state and duplicate-line semantics.

## 7. Integration and rollout

The first reference-enabled cohort should use the verified standard Node filesystem execution path, including DataAgent daemon sessions only after confirming that execution ownership. A production tag or a daemon UI does not establish the underlying file execution route. Keep the schema/capability choice stable during a session. Unsupported routes must not advertise or issue usable references.

| Component / consumer                                                                                                                                  | Required work                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/tools/edit.ts`, `utils/editHelper.ts`                                                                                              | Candidate diagnostics, compatible argument variants, reference binding, confirmation and execution validation  |
| `tools/priorReadEnforcement.ts`, `services/fileReadCache.ts`, `config/config.ts`                                                                      | Preserve existing file-wide policy; own scoped recovery state in the correct session/runtime                   |
| `core/coreToolScheduler.ts`, `packages/cli/src/acp-integration/session/Session.ts`                                                                    | Materialize equivalent inputs before hooks/permissions; revalidate hook and confirmation changes               |
| `tools/tool-error.ts`, `tools/tools.ts`, `tools/tool-response-finalizer.ts`, `tools/execution-tool.ts`                                                | Preserve complete recovery blocks on confirmation, execution, remote forwarding and final delivery             |
| `tools/read-file.ts`, `utils/fileUtils.ts`, `core/llm-chat.ts`, `core/client.ts`                                                                      | P2 raw coverage plus delivery and compaction invalidation                                                      |
| `services/ssh-execution-environment.ts`, `packages/cli/src/serve/hosted-workspace-tool-turn.ts`, `packages/cli/src/serve/hosted-csi-tool-evidence.ts` | Independent edit implementations/strict schemas; retain conventional behavior until parity is verified         |
| `mods/tool-dialect.ts`, `packages/web-shell/client/components/messages/ToolGroup.tsx`                                                                 | Field allowlists and old/new-based diff fallbacks must receive supported arguments or a real materialized diff |

Paths without a package prefix in this table are under `packages/core/src/`. This is a consumer map, not a commitment to edit every file in the first patch. It is not an `edit.ts`-only change. ACP, remote workers, SSH, Hosted/CSI and dialect adapters require explicit parity checks before inclusion. Existing notebook tools, new-file creation, `replace_all` and success behavior keep their established contracts.

Split delivery into P0 diagnostics, P1 ownership/input-resolution/output-preservation plus recovery, and a separately evaluated P2. Preserve conventional calls as the fallback. Rollback disables reference issuance and leaves ordinary editing available; no persistent-state migration is required.

## 8. Validation and acceptance

Replay sanitized reproductions of the two investigated workflows: missing characters, numerical transcription drift, internal alignment spaces, and stale reads after a same-session shell write. Include both unchanged and revised replacements. The existing case traces establish a baseline, not the outcome of an unimplemented alternative.

Correctness cases must include duplicate blocks, deleted/recreated look-alikes, changed target content, exterior changes, same-size/same-mtime mutation, path replacement, cross-session IDs, read permission denial, approval wait races, input-modifying hooks, IDE changes, cancellation, result hooks, output truncation, compaction and runtime restart. Verify encoding/BOM/CRLF preservation and unchanged behavior of conventional edits. Test confirmation-required and automatic modes separately. If a route cannot satisfy ownership and final-delivery invariants, verify that it emits no usable reference.

For stable, fully delivered, unambiguous targets, P1 acceptance is one explicit retry after failure with no intervening read and no old-text emission. When the replacement is unchanged, the retry also need not repeat it. Ambiguous, oversized or newly changed targets must refuse rather than force that target. Regression fixtures must have zero unintended writes; passing fixtures is not a universal zero-miswrite claim.

Measure whole recovery episodes, not just individual tool spans:

- Number of model turns and read/grep/shell calls between failure and completed intended edit.
- Input/output tokens for all those turns, cached input separately, plus old/new character counts. Do not call all output tokens wasted or substitute character estimates for provider usage.
- Failure-to-success latency, terminal edit success, abandonment and fallback to shell.
- Candidate coverage, reference usage, invalidation reasons, output-budget pressure and prompt-cache impact.

Stratify by no-match versus stale, target size, model, runtime and automatic versus interactive approval. Match sessions/cohorts and exclude background-memory work consistently. Suggested rollout goals are at least 50% fewer extra reads and 30% fewer recovery output tokens on eligible episodes, with no observed correctness or completion regression. These are proposed acceptance targets to validate, not predicted or measured savings. Also report population-wide results so eligibility does not hide a low-coverage optimization.

Before implementation acceptance, run focused unit tests, build/typecheck and real CLI E2E with the actual serving and approval paths. Then run paired model experiments and a small production cohort. Do not infer a 43-second saving from the SQL case or promise a 50-token whole edit when a large replacement still has to be generated.

## 9. Decisions left for implementation

Tune candidate confidence and output bounds using the sanitized corpus, and verify schema compatibility across the supported providers. Confirm the first production cohort's execution owner and final-delivery path before enabling IDs. Choose final field names only after that provider check; the semantics above are the proposal.

Do not broaden whitespace matching or copy dsh's persistent anchor infrastructure as a shortcut. The recommended investment is actionable failure content plus explicit snapshot-bound references. It directly addresses both observed recovery loops while leaving a measurable path toward eliminating initial old-text transcription.

## 10. Implemented scope and regression corpus

This change implements P0, P1 and P2 for standard local Node filesystem sessions. Supported sessions advertise the reference forms in Edit and return references from bounded Read results, recoverable failures and complete success snippets. Full source snapshots are capped at 1 MiB; each reference block is capped at 120 lines and 16 KiB, with at most eight references and 1 MiB of retained text per session. Larger or unsupported reads keep conventional editing. Reference issuance is disabled for execution facades/workers, managed or sandboxed execution, custom/delegated filesystem services and sessions with the read cache disabled. Both the CLI scheduler and the ordinary local ACP/daemon path materialize reference inputs before hooks and permissions. This PR does not deploy these changes to DataAgent production.

Whole-line replacements preserve the final newline of a newline-terminated range when the nonempty replacement omits it; an empty replacement deletes the selected range. A hook that changes this invariant must supply a valid whole-line replacement. User editor modifications that change the target to a whole-file edit return to ordinary prior-read enforcement. No relocation or whitespace-insensitive write authorization is added.

The [regression corpus](../../packages/core/src/tools/fixtures/README.md) contains 50 independent observed failures from 50 sessions: 39 no-match and 11 stale. It is selected diagnostic data, not a representative rate sample. All business text is replaced with per-case neutral tokens; provenance and mappings remain private. All 50 cases reproduce their original refusal with real temporary-file I/O and assert no mutation. Seven have independently corroborated same-target recovery oracles and exact expected resulting content; the other 43 establish refusal safety, not recovery correctness.

Of those seven, four exercise P1 recovery and three exercise a bounded P2 read followed by range editing. The unchanged-replacement case omits `new_string`; changed proposals use the observed successful replacement. Tests distinguish issuing a candidate reference from proving its intended-target correctness. Additional unit/pipeline and compiled-CLI tests cover hooks, permissions, human confirmation, stale snapshots, duplicates, encoding, result delivery and history invalidation. Mock-provider CLI tests verify the actual client/tool loop and compact wire arguments; they do not establish natural model efficiency or provider-wide acceptance. A separate bounded smoke with the configured `DeepSeek/deepseek-v4-flash` endpoint completed five real API requests and four tool calls: bounded read, read-reference edit, intentional no-match, then recovery-reference retry with no old/new fields or intervening read. The final file and captured wire arguments matched the expected behavior. This verifies that one configured provider/model combination; comparative latency/token savings and production rollout remain future validation.
