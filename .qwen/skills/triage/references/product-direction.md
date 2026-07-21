# Product Direction Review

Use this procedure for issue feature requests and PR Stage 1c. It informs the
existing triage decision; it does not own comments, labels, reviews, or approval.

## 1. Build one evidence packet

Before branching on CI configuration, run this fixed command once (never append
issue or PR text to it):

```bash
printf 'TRIAGE_REFERENCE_STATUS=%s\nTRIAGE_REFERENCE_PATH=%s\nTRIAGE_ARENA_ENABLED=%s\n' "${TRIAGE_REFERENCE_STATUS:-}" "${TRIAGE_REFERENCE_PATH:-}" "${TRIAGE_ARENA_ENABLED:-false}"
```

Capture the proposal, demonstrated user problem, requested behavior, and the
smallest plausible solution. Search Qwen Code source, docs, and related GitHub
issues for concrete precedent.

If `TRIAGE_REFERENCE_STATUS=available` and `TRIAGE_REFERENCE_PATH` points to an
existing directory, search that checkout with `grep_search`, `glob`, and
`read_file`. Use 3-5 literal technical terms from the proposal. Do not
interpolate issue or PR text into shell commands. Record the relevant paths and
behavior, not large excerpts.

If that checkout is unavailable for any reason, use the fixed Claude Code
changelog as a weaker fallback:

```bash
curl -fsSL https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md -o "${RUNNER_TEMP:?}/claude-code-changelog.md"
```

Search the downloaded file with `grep_search`. If the configured source clone
failed (`TRIAGE_REFERENCE_STATUS=configured-unavailable`), say so in the final
direction assessment instead of silently presenting changelog evidence as
source review.

Reference-product precedent is advisory. A matching feature supports relevance;
no match is not a rejection.

## 2. Run independent reviewers when arena is enabled

When `TRIAGE_ARENA_ENABLED=true`, compose one self-contained prompt containing
the same proposal and evidence packet for both reviewers. Launch
`product-direction-reviewer` and `product-direction-challenger` with that exact
prompt and `run_in_background: false`, in the same tool-call batch when
possible. Launch both before reading either result. Do not include either
reviewer's output in the other's prompt.

The two agents assess direction only. They must not post comments, edit labels,
approve, reject, inspect additional files, or modify files. Their declared tool
blocklist covers every tool enabled by the triage job; give them all relevant
evidence in the prompt.

If arena is not enabled, assess the evidence directly in the parent triage
agent. Do not launch two inherited-model agents and call that multi-model review.

## 3. Judge and degrade safely

The parent triage agent is the judge:

- Agreement: synthesize the shared conclusion and strongest evidence.
- Disagreement: identify the disputed assumption. If it materially affects
  direction, confidence is low, or the change is high-risk, escalate to a
  maintainer instead of auto-rejecting.
- One reviewer fails: continue with the surviving assessment and disclose that
  arena coverage degraded.
- Both reviewers fail: fall back to the parent's direct assessment and disclose
  that arena was unavailable.

Always report whether reference source was used and whether arena was disabled,
agreed, disagreed, or degraded. Never expose credentials or private source
content in GitHub comments.
