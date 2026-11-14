# Edit recovery regression cases

This corpus contains 50 independent, observed Edit failures from 50 DataAgent
sessions whose telemetry was marked `production`: 39 no-match failures and 11
stale-read rejections. It is a selected regression corpus, not a representative
sample or a recovery-rate benchmark. Original session, account, trace, and call
identifiers are not included.

`coverage` describes whether the observed text covers a full file or an excerpt.
`evidence` identifies a successful Read result or a reconstruction from an
observed Write and subsequent successful literal edits. A snapshot can precede
the failure or come from a nearby following Read; it is not necessarily a
failure-moment filesystem snapshot. Stale cases include both the previously
observed text and a following Read of the current text.

Seven no-match cases have `recoveryEligible: true`. Their `expectedCandidate`
is an observed, unique source region corroborated by a successful edit of the
same target, with matching surrounding context. `repairedNewString` is that
successful edit's actual replacement, also present in its tool result.
`expectedContent` applies that independently observed replacement to the
fixture's observed snapshot. It does not claim to be an archived post-edit
whole-file snapshot. The original failed replacement is retained separately as
`newString`.

Other cases have a null candidate and provide baseline refusal and no-mutation
coverage. A subsequent edit of the same file is not automatically treated as a
retry of the failed target. No test should infer automatic recovery success for
all 50 cases.

The 11 stale cases include six identical visible snapshots, two differing only
in a final newline, and three with other text changes. Staleness is a file
fingerprint decision, so identical text can still accompany a real rejection.
Replay tests recreate the observed fingerprint drift using temporary-file
metadata; original filesystem timestamps are not included.

Business identifiers, prose, numbers, strings, paths, and URL words were replaced
with independent per-case neutral tokens. Related transcription variants are
projected onto anonymous tokens. Standard token prefixes are `n_`, `t_`, and
`v_`; their shorter spelling keeps the complete corpus within review limits.
Line counts and whitespace are preserved;
token lengths and lexical types can change. The text is string-test data, not
executable SQL or code. Original-to-anonymous mappings and provenance remain
private and are not part of this repository.

Before inclusion, the original and anonymous no-match inputs were both checked
against the existing matcher, and the stale inputs were replayed through the
file-read cache and prior-read check. Each collected tool-context query was
paginated and checked against its source row and distinct-span counts.
