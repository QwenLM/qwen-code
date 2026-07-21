# Product-direction arena for triage

## Problem

Qwen triage currently evaluates product direction in a single model turn. PR
triage can consult Claude Code's public changelog, but it cannot inspect a
maintainer-selected source repository, and the issue workflow delegates feature
direction to `/goal` without a CI configuration that guarantees that command is
available.

The repository already supports declarative subagents with per-agent model
selection. The interactive `/arena` command is not suitable here: it requires a
human to select a winner and is unavailable to headless clients.

## Design

The existing `/triage` skill remains the only workflow entrypoint and the only
owner of GitHub comments, labels, reviews, and approvals.

Four optional repository Actions variables enable two capabilities:

| Variable                     | Behavior                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_SRC_PATH`       | An existing absolute Claude Code source directory on a self-hosted runner. Preferred when available.  |
| `QWEN_TRIAGE_REFERENCE_REPO` | A public HTTPS GitHub repository fetched for read-only product-direction source searches.             |
| `QWEN_TRIAGE_REFERENCE_REF`  | The reviewed 40-character commit SHA to fetch from that repository. Required with the repository URL. |
| `QWEN_TRIAGE_ARENA_MODEL`    | A second model ID available through the triage job's OpenAI-compatible endpoint.                      |

When the existing runner path is available, CI exposes it to `/triage` directly
for backward compatibility. Otherwise, when the reference repository and
reviewed commit are configured, CI fetches only that commit into an ignored
directory inside the trusted checkout and exposes its local path. The fetch and
checkout are capped at 90 seconds. Failure is non-fatal because competitive
evidence is advisory; triage records that the configured source was unavailable.

When the arena model is configured, CI changes the declarative challenger agent
from `inherit` to that model before Qwen starts. `/triage` sends the same
self-contained evidence packet to the primary reviewer and challenger, then
synthesizes their independent results. Disagreement is a reason for conservative
maintainer escalation, never an automatic rejection.

With none of these variables configured, triage keeps its existing single-model
behavior. Configuring either an available runner path or the reference
repository and commit enables source-informed single-model review. Adding the
arena model enables source-informed cross-model review.

## Security and ownership

- Only repository Actions variables select the runner path, repository, and
  secondary model; issue and PR text cannot change them.
- The runner path must be an existing absolute directory. Maintaining and
  pinning its contents remains a runner-operations responsibility.
- Reference URLs are restricted to public `https://github.com/` URLs.
- Reference contents and issue/PR text are treated as untrusted evidence, not
  instructions.
- Reviewer agents explicitly disallow every tool enabled by the triage job and
  cannot inspect credentials, files, or GitHub state beyond the evidence
  packet.
- The parent triage agent remains responsible for every public side effect.

## Files affected

- The triage workflow prepares optional source and model context.
- Two project subagent definitions provide independent direction assessments.
- A shared triage reference defines evidence gathering, fan-out, judging, and
  fallback behavior for both issues and PRs.
- Maintainer automation documentation describes activation and degradation.
- Script tests pin the workflow wiring and skill contract.

## Out of scope

- Reusing the interactive Arena manager in headless mode.
- Installing or authenticating additional model providers in CI.
- Persisting arena artifacts after a workflow run.
- Allowing subagents to post comments, change labels, or approve PRs.

## Open question

The secondary model must be served by the same OpenAI-compatible endpoint used
by triage. A future change can add a separately authenticated provider if the
repository needs cross-provider routing.
