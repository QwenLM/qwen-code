/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The gap these close, and the noise they must not make.
//
// `/review` runs on other people's repositories. A built-in checklist that fires on
// every one of them, saying things their maintainers already decided against, is not
// a feature — it is the thing that teaches an author to stop reading the review. So
// two properties are tested here with equal weight: that the rule ARRIVES when the
// diff touches a workflow, and that it is ABSENT, and silent, when it does not.

import { describe, it, expect } from 'vitest';
import { pathRulesFor, PATH_RULES } from './path-rules.js';

describe('pathRulesFor — scoped, or it is noise', () => {
  it('is empty for a diff that touches no rule-governed file', () => {
    // The common case, and the one that has to cost nothing. A TypeScript PR must
    // not be handed a GitHub Actions syllabus.
    expect(pathRulesFor(['src/pay.ts', 'src/pay.test.ts', 'README.md'])).toBe(
      '',
    );
  });

  it('is empty for a diff with no files at all', () => {
    expect(pathRulesFor([])).toBe('');
  });

  it('attaches the workflow checklist when a workflow changes', () => {
    const out = pathRulesFor(['.github/workflows/ci.yml', 'src/pay.ts']);
    expect(out).toContain('GitHub Actions workflows');
    // And it names which file triggered it — an agent that cannot see why a rule
    // arrived applies it to the wrong file.
    expect(out).toContain('.github/workflows/ci.yml');
    expect(out).not.toContain('src/pay.ts');
  });

  it.each([
    ['.github/workflows/ci.yml', true],
    ['.github/workflows/nested/ci.yaml', true],
    ['.github/actions/setup/action.yml', true],
    ['.github/dependabot.yml', false],
    ['.github/ISSUE_TEMPLATE/bug.yml', false],
    ['deploy/workflows/ci.yml', false],
    ['src/github/workflows/ci.yml', false],
    ['src/main/java/com/x/Main.java', true],
    ['Main.java', true],
    ['src/main/kotlin/Main.kt', false],
    ['docs/notes.java.md', false],
    ['scripts/build.sh', true],
    ['tools/release.bash', true],
    // pathTool routes .ksh/.dash to shellcheck, so the lane syllabus is owed
    // to the same files; the rest pin every remaining extension alternative.
    ['scripts/deploy.ksh', true],
    ['tools/setup.dash', true],
    ['scripts/win/setup.ps1', true],
    ['ci/cleanup.zsh', true],
    ['tools/win/build.bat', true],
    ['tools/win/setup.cmd', true],
    ['.github/scripts/label-pr.mjs', true],
    // py/rb/pl are matched by no lane branch of their own — they reach the
    // lane syllabus only through the rule's composition with the
    // GITHUB_ACTIONS arm; these rows pin each spelling of the filter.
    ['.github/scripts/triage.py', true],
    ['.github/scripts/hook.rb', true],
    ['.github/scripts/tool.pl', true],
    // The node spellings the script arm admits that no lane arm rescues:
    // js pins the bare [cm]? form, cjs the c-branch, tsx the x-suffix.
    ['.github/scripts/helper.js', true],
    ['.github/scripts/helper.cjs', true],
    ['.github/scripts/helper.tsx', true],
    ['.github/actions/setup/entrypoint.sh', true],
    ['.github/actions/setup/README.md', false],
    // A document under .github/scripts has no lanes and no shell.
    ['.github/scripts/README.md', false],
    ['scripts/tests/install-script.test.js', true],
    ['scripts/tests/install-script.test.mts', true],
    ['packages/cli/scripts/tests/pack.spec.ts', true],
    // The suite config decides which lanes collect the script tests, and it
    // carries a live platform gate — the lane-inventory question applies.
    ['scripts/tests/vitest.config.ts', true],
    ['scripts/tests/vitest.config.mts', true],
    // Mid-path form: the anchor is a scripts/tests directory wherever it
    // sits, not the repo root.
    ['packages/cli/scripts/tests/vitest.config.ts', true],
    // The scripts-test branch is anchored to a scripts/ directory, not to a
    // directory that merely ends in the word.
    ['myscripts/install.test.ts', false],
    ['prescripts/tests/vitest.config.ts', false],
    // A Dockerfile's RUN lines are shell in the image's userland; every
    // spelling pathTool's hadolint branch recognises is governed.
    ['Dockerfile', true],
    ['docker/build.dockerfile', true],
    ['ci/Dockerfile.alpine', true],
    ['src/mydockerfile', false],
    // The lane rule composes pathTool's basename-based hadolint branch: a
    // file UNDER a directory merely named Dockerfile.* is not a Dockerfile.
    ['Dockerfile.d/README.md', false],
    ['docker/Dockerfile.prod/app.conf', false],
    // The hadolint arm narrows pathTool's basename-prefix branch for the
    // brief: a document about Dockerfiles is prose, not a build recipe —
    // every extension the guard names is pinned, or a narrowing of the
    // list ships green.
    ['docs/dockerfile.md', false],
    ['docs/dockerfile.best-practices.md', false],
    ['docs/dockerfile.txt', false],
    ['docs/dockerfile.rst', false],
    ['docs/dockerfile.adoc', false],
    ['docs/dockerfile.html', false],
    ['docs/dockerfile.org', false],
    ['docs/dockerfile.yaml', false],
    ['docs/dockerfile.json', false],
    ['Dockerfile.swp', false],
    ['docker/Dockerfile.lock', false],
    // A test outside the script layer is not handed a shell syllabus, and a
    // document that merely talks about one is not code.
    ['src/pay.test.ts', false],
    ['scripts/build.js', false],
    ['docs/how-to-run.sh.md', false],
    // The security checklist's script arm stops at the two workflow-helper
    // conventions under .github: which scripts a workflow calls beyond them
    // is content-defined, and a path matcher that cannot see run: lines
    // must not pretend otherwise.
    ['scripts/triage.py', false],
    // Extensionless hooks are shellchecked by toolFor's shebang branch,
    // which reads content; matches() sees the path alone and cannot tell a
    // hook from a README, so it declines to guess — a visible decision.
    ['.husky/pre-commit', false],
    ['hooks/prepush', false],
  ])('%s → governed by a rule: %s', (path, governed) => {
    expect(PATH_RULES.some((r) => r.matches(path))).toBe(governed);
  });

  it('names the attack classes no dimension agent would think to ask about', () => {
    const out = pathRulesFor(['.github/workflows/x.yml']);
    // The one that matters most: a privileged trigger that runs the contributor's
    // code with the base repository's write token.
    expect(out).toContain('pull_request_target');
    expect(out).toContain('head.sha');
    // Expression injection into `run:`.
    expect(out).toMatch(/interpolated into a `run:`/);
    // And the two that shade into taste, which is why they are Suggestions.
    expect(out).toContain('mutable tag');
    expect(out).toContain('permissions:');
  });

  it('does not turn a foreign project into a lint sweep', () => {
    // Three self-restraints, because /review runs on repositories whose maintainers
    // never asked for this: it reviews the DIFF, it exempts the conventions almost
    // everyone keeps, and it says out loud that a false alarm costs more than a
    // missed nit.
    const out = pathRulesFor(['.github/workflows/x.yml']);
    expect(out).toContain('reviewing this diff, not auditing this file');
    expect(out).toMatch(/actions\/\*.*common exception/s);
    expect(out).toContain('Favour precision over recall');
    // The two taste-adjacent items are Suggestions, and say so.
    expect(out).toMatch(/\*\*Recommendations \(Suggestion\)/);
  });

  it('does not make the blast radius of a blocker into a separate Suggestion', () => {
    // Dogfooded against a planted vulnerability, the security agent read the flat
    // rule ("`permissions:` is a Suggestion") and escalated anyway — "grants maximum
    // token scope to a job that processes untrusted contributor code, amplifying the
    // RCE above". It was right and the rule was too coarse. A broad token on a job
    // that runs the contributor's code is not a recommendation; it is how far the
    // blocker reaches.
    const out = pathRulesFor(['.github/workflows/x.yml']);
    expect(out).toContain('blast radius of the blocker above');
  });

  it('asks whether a cache mechanism can fire at all, not only whether it is safe', () => {
    // The checklist already covered a cache a fork can *poison*. It said nothing
    // about one that can never *hit*, and on a real PR that gap held: the producer
    // and the consumer shared a key and shared the `path:` line, so every
    // YAML-shape assertion went green while `actions/cache` hashed two different
    // `version`s — host path vs container path, zstd vs gzip — and no restore
    // could ever match. Shape parity between the two sides is not identity parity,
    // and no dimension agent asks which runner each side actually runs on.
    const out = pathRulesFor(['.github/workflows/x.yml']);
    expect(out).toContain('never agree on identity');
    // What settles it is a comparison of environments, not of YAML strings.
    expect(out).toMatch(/Compare the \*\*environments\*\*/);
    expect(out).toContain('runs-on');
    // And a miss nobody can observe is part of the finding, not a separate nit.
    expect(out).toContain('$GITHUB_STEP_SUMMARY');
  });

  it('caps the path list for workflow files too', () => {
    // The cap is rule-agnostic: a diff touching 15 workflows gets the same
    // truncation as a large Java PR.
    const many = Array.from(
      { length: 15 },
      (_, i) => `.github/workflows/ci${i}.yml`,
    );
    const out = pathRulesFor(many);
    expect(out).toContain('…and 5 more');
    expect(out).toContain('.github/workflows/ci9.yml');
    expect(out).not.toContain('.github/workflows/ci10.yml');
  });
});

describe('pathRulesFor — the shell/CI-lane rule', () => {
  // The gap it closes, measured on a real PR (#9220): eight review rounds on
  // Linux runners hardened a workflow's wipe script, added `realpath -m` to
  // canonicalize its path guard, and added a test pinning that line. `-m` is a
  // GNU coreutils extension — Darwin's realpath(1) exits 1 on it — so the
  // script's `|| printf` fallback silently keeps the raw path and the new test
  // is red on the `test_macos` lane. Nothing caught it: every agent ran on a
  // GNU host, and no dimension asks which lanes execute a file. A human
  // reviewer running the suite on a Mac found it in one round.
  it('attaches to shell, CI scripts, and the tests that drive them', () => {
    const out = pathRulesFor([
      'scripts/tests/qwen-pr-review-workflow.test.js',
      'src/pay.ts',
    ]);
    expect(out).toContain('Shell and CI scripts — the lanes that run them');
    expect(out).toContain('scripts/tests/qwen-pr-review-workflow.test.js');
    expect(out).not.toContain('src/pay.ts');
  });

  it('stacks with the workflow rule on a diff that changes embedded shell', () => {
    // The security checklist owns what the workflow does with its token; this
    // one owns whether its `run:` block works on the hosts it runs on. A
    // workflow diff needs both, and neither subsumes the other.
    const out = pathRulesFor(['.github/workflows/ci.yml']);
    expect(out).toContain('GitHub Actions workflows');
    expect(out).toContain('Shell and CI scripts — the lanes that run them');
  });

  it('pins the composite-action branch of the shell rule itself', () => {
    // A table row only proves SOME rule matched; this pins that the lane
    // syllabus itself reaches a diff touching only a composite action, whose
    // `run:` blocks are the miss this rule exists to catch — per rule, and
    // in both metadata spellings GitHub accepts: nothing else rescues an
    // actions/ path, so a narrowing to one spelling fails here.
    for (const name of ['action.yml', 'action.yaml']) {
      const out = pathRulesFor([`.github/actions/setup/${name}`]);
      expect(out).toContain('Shell and CI scripts — the lanes that run them');
      expect(out).toContain('GitHub Actions workflows');
    }
  });

  it.each([
    '.github/scripts/pr-safety-precheck.mjs',
    '.github/scripts/cleanup.sh',
    '.github/scripts/deploy.ps1',
    '.github/scripts/release.ts',
    '.github/actions/setup/helper.py',
    // Spellings the lane rule rescues through its own arms — only these
    // per-rule assertions can pin them for the workflow arm.
    '.github/scripts/provision.bash',
    '.github/scripts/ci/lint.zsh',
    '.github/scripts/provision.ksh',
    '.github/scripts/provision.dash',
    '.github/scripts/win/build.bat',
    '.github/scripts/win/setup.cmd',
    // The node spellings the arm admits beyond mjs/ts.
    '.github/scripts/helper.js',
    '.github/scripts/helper.cjs',
    '.github/scripts/helper.tsx',
  ])('pairs both checklists on a script-only diff (%s)', (path) => {
    // The security checklist says the scripts a workflow calls are part of
    // the workflow, so a diff touching only such a script needs the
    // expression-injection eyes and the lane eyes together — asserted per
    // rule, because the lane rule rescues bash/ksh/dash through pathTool's
    // shellcheck branch and zsh/ps1/bat/cmd through its own suffix arm: a
    // `.some()` row then stays green when the workflow arm alone drops a
    // spelling, and only these assertions can see the deletion.
    const out = pathRulesFor([path]);
    expect(out).toContain('GitHub Actions workflows');
    expect(out).toContain('Shell and CI scripts — the lanes that run them');
  });

  it('pairs both checklists on a composite-action script', () => {
    // A script under a composite action is as much "a script the workflow
    // calls" as one under .github/scripts — the action's shell invokes it
    // with the same interpolated arguments — so it draws the same pairing.
    const out = pathRulesFor(['.github/actions/setup/entrypoint.sh']);
    expect(out).toContain('GitHub Actions workflows');
    expect(out).toContain('Shell and CI scripts — the lanes that run them');
  });

  it('does not govern non-script files under .github/scripts', () => {
    // The scripts arm filters on script extensions: a README or JSON fixture
    // there has no lanes and no shell, so it draws neither checklist.
    expect(pathRulesFor(['.github/scripts/README.md'])).toBe('');
  });

  it('attaches to Dockerfiles, and only to the lane checklist', () => {
    // A RUN line is shell executing in the image's userland — the
    // Alpine/busybox lane the GNU-ism bullet is written about — but a
    // Dockerfile is not a workflow, so the security checklist stays absent.
    const out = pathRulesFor(['Dockerfile']);
    expect(out).toContain('Shell and CI scripts — the lanes that run them');
    expect(out).not.toContain('GitHub Actions workflows');
  });

  it('attaches to the suite config that decides which lanes collect the tests', () => {
    // scripts/tests/vitest.config.ts carries the suite's platform gate; a
    // diff editing that gate is exactly what the lane-inventory question is
    // for.
    const out = pathRulesFor(['scripts/tests/vitest.config.ts']);
    expect(out).toContain('Shell and CI scripts — the lanes that run them');
  });

  it('makes the lane inventory the first question, including the skipped ones', () => {
    // The trap is structural, not linguistic: a merge_group-only job reports as
    // "skipped" on the PR page, so a fully green PR is not evidence about it,
    // and the first red lands in the queue where it ejects the whole batch.
    const out = pathRulesFor(['scripts/build.sh']);
    expect(out).toContain('which lanes execute this file');
    expect(out).toContain('merge_group');
    expect(out).toMatch(/reports as \*\*skipped\*\*|reports as \*\*skipped/);
    expect(out).toContain('merge-queue failure');
    // A suite excluded on one platform is not excluded on the others — the
    // exact shape of the miss on #9220 (vitest.config.ts gated win32 only).
    expect(out).toMatch(/gated off Windows is \*\*not\*\* gated off macOS/);
  });

  it('names the non-GNU userlands and the flags that differ', () => {
    const out = pathRulesFor(['scripts/build.sh']);
    expect(out).toContain('realpath -m');
    expect(out).toContain('busybox');
    expect(out).toContain('sed -i');
    // The silent-degradation shape: the fallback means nothing fails, the
    // guard just stops happening.
    expect(out).toContain('silently skips the canonicalization');
  });

  it('separates the two findings a GNU-ism produces, at different severities', () => {
    // A Linux-only production script with a GNU-ism is not a bug; the test that
    // asserts the GNU behaviour on a macOS lane is. Collapsing the two produces
    // either a false alarm on the script or a missed red lane.
    const out = pathRulesFor(['scripts/build.sh']);
    expect(out).toMatch(/not the same severity/);
    expect(out).toMatch(/gate the \*\*test\*\*, not to weaken the script/);
  });

  it('pins the path-identity and privilege traps', () => {
    const out = pathRulesFor(['scripts/build.sh']);
    expect(out).toContain('/private/var/folders');
    expect(out).toContain('realpathSync');
    expect(out).toContain('CAP_DAC_OVERRIDE');
    // A vacuously-passing test is the failure mode root hides behind.
    expect(out).toMatch(/assertion vacuous/);
  });

  it('prescribes a capability probe rather than a platform check', () => {
    // `skipIf(platform === 'darwin')` is wrong in both directions, so the fix
    // shape has to be named — it is the part the model does not supply itself.
    const out = pathRulesFor(['scripts/build.sh']);
    expect(out).toContain('probe the capability, not the platform');
    expect(out).toContain("spawnSync('realpath'");
    expect(out).toContain('busybox lane');
  });

  it('keeps the severity and scoping discipline of the skill', () => {
    const out = pathRulesFor(['scripts/build.sh']);
    expect(out).toContain('reviewing this diff, not auditing this file');
    expect(out).toContain('Favour precision over recall');
    // The receipt: a lane and a mechanism, or it is a worry, not a finding.
    expect(out).toMatch(/If you cannot name the lane, you do not have one/);
  });

  it('keeps the lane heading in diff order — no JVM-layout demotion', () => {
    // The demotion that pushes src/test paths past the heading cap belongs
    // to the JAVA rule's own scoping. The lane rule's first blocker bullet
    // is written ABOUT the test scripts, so its heading must keep showing
    // them — under the cap they are the first files owed the inventory
    // question, not the first elided.
    const fixtures = [
      'src/test/resources/scripts/deploy.sh',
      'src/test/resources/scripts/provision.sh',
      'src/test/resources/scripts/teardown.sh',
    ];
    const prod = Array.from({ length: 10 }, (_, i) => `scripts/s${i}.sh`);
    const out = pathRulesFor([...fixtures, ...prod]);
    const heading =
      out.split('\n').find((l) => l.startsWith('### Shell and CI scripts')) ??
      '';
    for (const f of fixtures) {
      expect(heading).toContain(f);
    }
  });
});

describe('pathRulesFor — matcher cost stays linear on attacker-shaped paths', () => {
  // A pull request's file paths are attacker-controlled and flow uncapped
  // into matches() — git accepts a 96,481-character path — so a matcher
  // that backtracks quadratically stalls every agent-brief build of the
  // review synchronously: the JAVA checklist in this file grades exactly
  // that shape Critical. The bound is generous to slow runners; linear
  // matchers finish these inputs in microseconds.
  const BOUND_MS = 250;

  const msOf = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it("the workflow rule's script arm pays no nested-quantifier cost", () => {
    // Many segments and no dot anywhere: the arm never matches, and a
    // nested pair of unbounded quantifiers pays that failed match once per
    // split point — quadratic in the path length.
    const path = `.github/actions/${'a/'.repeat(48_000)}a`;
    expect(msOf(() => pathRulesFor([path]))).toBeLessThan(BOUND_MS);
  }, 60_000);

  it("the workflow rule's scripts sub-alternative stays linear too", () => {
    // The symmetric `.github/scripts/` side of the same arm, on the same
    // many-segments-no-dot shape: a future edit that re-anchors it with an
    // unbounded suffix must not ship with every timing test green.
    const path = `.github/scripts/${'a/'.repeat(48_000)}a`;
    expect(msOf(() => pathRulesFor([path]))).toBeLessThan(BOUND_MS);
  }, 60_000);

  it("the lane rule's scripts-test arm pays no per-anchor cost", () => {
    // A scripts/ directory at every level: a leading anchor followed by a
    // backtracking suffix pays the failed suffix once per anchor.
    const path = `scripts/${'scripts/'.repeat(40_000)}x`;
    expect(msOf(() => pathRulesFor([path]))).toBeLessThan(BOUND_MS);
  }, 60_000);

  it('pathTool pays no per-anchor cost on a repeated workflows prefix', () => {
    // The lane rule routes every path through pathTool, whose workflow
    // regex pays its failed suffix once per anchor whose prefix matches.
    const path = `.github/workflows/${'.github/workflows/'.repeat(16_000)}x`;
    expect(msOf(() => pathRulesFor([path]))).toBeLessThan(BOUND_MS);
  }, 60_000);
});

describe('pathRulesFor — the Java/JVM rule', () => {
  it('attaches when a .java file changes, and names only that file', () => {
    const out = pathRulesFor(['src/main/java/com/x/Main.java', 'src/pay.ts']);
    expect(out).toContain('Java / JVM performance');
    expect(out).toContain('src/main/java/com/x/Main.java');
    expect(out).not.toContain('src/pay.ts');
  });

  it('stacks with the workflow rule when a diff touches both', () => {
    const out = pathRulesFor(['.github/workflows/ci.yml', 'src/Main.java']);
    expect(out).toContain('GitHub Actions workflows');
    expect(out).toContain('Java / JVM performance');
  });

  it('names the inline thresholds and both verification tiers', () => {
    const out = pathRulesFor(['src/Main.java']);
    // The table the whole JIT section hangs on: 325 is the user's case — a hot
    // method that outgrows FreqInlineSize stops being inlined.
    expect(out).toContain('FreqInlineSize');
    expect(out).toContain('325');
    expect(out).toContain('MaxInlineSize');
    // Static tier: compile and measure with javap; dynamic tier: PrintInlining.
    expect(out).toContain('javap');
    expect(out).toContain('PrintInlining');
  });

  it('cites the thresholds a maintainer will check, correctly', () => {
    // A checklist whose thesis is "don't guess the numbers" loses all trust the
    // moment it cites a wrong one. These three were wrong in the first draft
    // (InlineSmallCode quoted as the pre-JDK-17 value, HugeMethodLimit called a
    // product flag with a ≥ boundary, megamorphic stated as unconditional) and a
    // review measured them against a live JVM. Pin the corrected forms.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('2500 on JDK 17+');
    expect(out).toContain('2000 on JDK 8');
    expect(out).toContain('DontCompileHugeMethods');
    expect(out).toMatch(/> 8000/);
    expect(out).toContain('TypeProfileMajorReceiverPercent');
  });

  it('describes the inline table as size caps, not inlining outcomes', () => {
    // A review reproduced C2 declining a 10-byte callee for `low call site
    // frequency`: size is one gate among several, so the table reads as size
    // caps and a "can no longer be inlined" claim needs the dynamic tier — a
    // javap size diff alone proves only a threshold crossing, not an inlining
    // change. The outcome words that contradicted that behaviour are gone.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('size caps');
    expect(out).toMatch(/necessary but not sufficient/);
    expect(out).toContain('low call site frequency');
    expect(out).toContain('needs the **dynamic** tier');
    expect(out).not.toContain('even when cold');
  });

  it('refuses to estimate bytecode from source', () => {
    // The one failure this checklist exists to prevent: an agent eyeballing a
    // method and declaring it un-inlinable. The honest form is the mechanism,
    // at low confidence, with the measurement named.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toMatch(/do not estimate bytecode from source/);
    expect(out).toContain('Confidence: low');
  });

  it('names hot/cold splitting as the fix, and rules out @ForceInline', () => {
    // A/B-measured: without the checklist the performance agent missed an
    // 80→338-byte threshold crossing entirely; with it, the agent proposed
    // extracting a named bytecode range into a helper. The fix shape is the
    // part the model does not supply on its own — pin it, and pin the
    // anti-pattern it must not suggest (@ForceInline bloats every caller).
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('hot/cold splitting');
    expect(out).toContain('@ForceInline');
    expect(out).toMatch(/bytecode range to extract/);
  });

  it('keeps the severity and scoping discipline of the skill', () => {
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('reviewing this diff, not auditing this file');
    expect(out).toContain('Favour precision over recall');
    // Inlining only matters where the call is hot; otherwise the rule is a
    // lint sweep over every method in the file.
    expect(out).toMatch(/cold method over 325 bytes is \*\*not\*\* a finding/);
    // Slow is a cost, not a wrongness — perf findings are Suggestions, and the
    // Criticals are reserved for the correctness traps.
    expect(out).toMatch(/Performance findings are \*\*Suggestions\*\*/);
  });

  it('prescribes a measurement that cannot mutate the tree or run contributor code', () => {
    // The roster runs nine agents in ONE worktree concurrently, and a local
    // review stands in the user's own checkout. Four distinct hazards the
    // procedure must close, each found by review:
    //  - a fixed scratch path (/tmp/scratch) collides between concurrent agents
    //    compiling different revisions of the same class → mktemp -d;
    //  - plain javac runs classpath annotation processors with the agent's
    //    privileges → -proc:none, and mvn/gradle (the branch's build logic) is a
    //    prohibition, not a discouraged preference;
    //  - -proc:none is also a fidelity hazard: on a Lombok/Dagger project the
    //    compiled class is missing generated members, so the static tier is void;
    //  - "extract and javac" fails on any class with imports, so the tier names
    //    a classpath path (-sourcepath / target/classes) and a graceful fall-back
    //    to the mechanism tier instead of escalating to a project build.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('mktemp -d');
    expect(out).toContain('-proc:none');
    expect(out).toContain('static tier is **void**');
    expect(out).toContain('git show');
    expect(out).toMatch(
      /never `git checkout`, `git stash`, build in place, or run `mvn`\/`gradle`/,
    );
  });

  it('pins the correctness traps that make this section Critical, not Suggestion', () => {
    // Probe-confirmed in review: deleting the entire correctness-traps block left
    // every test green, so a future edit could silently drop the only instruction
    // that grades a shared SimpleDateFormat or a get-then-put race as *wrong*.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('SimpleDateFormat');
    expect(out).toContain('ConcurrentHashMap');
    expect(out).toContain('computeIfAbsent');
    expect(out).toContain('volatile');
  });

  it('pins the JVM-cost defect patterns an agent would otherwise skim past', () => {
    // Same probe, Suggestion side: the nine source-provable patterns (regex,
    // string +=, boxing, capturing lambda, log guard, presizing, legacy
    // synchronized types, exceptions as control flow, per-call reflection) had
    // zero coverage. Spot-pin the load-bearing ones so a mangled section fails.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('Pattern.compile');
    expect(out).toContain('StringBuilder');
    expect(out).toContain('Boxing on a hot path');
    expect(out).toContain('newHashMap');
  });

  it('steers the fix away from JVM tuning flags and internal annotations', () => {
    // For a grown hot method the actionable fix is hot/cold splitting. The wrong
    // suggestions an agent reaches for are runtime knobs the PR author cannot
    // ship in a code change (-XX:FreqInlineSize, -XX:CompileCommand=inline) and
    // the JDK-internal @ForceInline, which application code cannot use at all —
    // none of these is general, so the checklist names them only to rule them out.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('hot/cold splitting');
    expect(out).toContain('CompileCommand=inline');
    expect(out).toMatch(/runtime knobs the PR's author cannot ship/);
    expect(out).toContain('@ForceInline` is not available to application code');
  });

  it('names production paths before test paths in the heading', () => {
    // The hot-path items the heading introduces do not apply under src/test, so a
    // PR that is mostly test classes must not fill the ten named slots with files
    // the rule scopes out. Production first, then tests.
    const tests = Array.from(
      { length: 30 },
      (_, i) => `src/test/java/com/x/T${i}Test.java`,
    );
    const prod = ['src/main/java/com/x/A.java', 'src/main/java/com/x/B.java'];
    const out = pathRulesFor([...tests, ...prod]);
    expect(out).toContain('src/main/java/com/x/A.java');
    expect(out).toContain('src/main/java/com/x/B.java');
    // The first named slot is production, not a test file.
    const heading = out.split('\n').find((l) => l.startsWith('### ')) ?? '';
    const prodIdx = heading.indexOf('A.java');
    const testIdx = heading.indexOf('T0Test');
    expect(prodIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(prodIdx).toBeLessThan(testIdx);
  });

  it.each([
    [
      'generated build output',
      Array.from(
        { length: 11 },
        (_, i) => `target/generated-sources/com/x/S${i}.java`,
      ),
    ],
    [
      'Maven generated test output',
      Array.from(
        { length: 11 },
        (_, i) =>
          `target/generated-test-sources/test-annotations/com/x/S${i}.java`,
      ),
    ],
    [
      'Gradle generated output',
      Array.from({ length: 11 }, (_, i) => `build/generated/com/x/S${i}.java`),
    ],
    [
      'non-Maven test roots',
      Array.from({ length: 11 }, (_, i) => {
        const root = ['integTest', 'androidTest', 'testFixtures'][i % 3];
        return `src/${root}/java/com/x/N${i}.java`;
      }),
    ],
    [
      'info-only sources',
      Array.from({ length: 11 }, (_, i) =>
        i < 6
          ? `src/main/java/com/x/p${i}/package-info.java`
          : `src/main/java/com/x/m${i}/module-info.java`,
      ),
    ],
  ])('deprioritizes %s past the cap, not just src/test', (_label, noise) => {
    // The checklist scopes out more than src/test. Each family below, once it
    // outnumbers the cap, must still not fill the named slots: the noise is
    // pushed past CAP so truncation bites, and the production path is asserted
    // to survive it. Drop the matching branch from isOutOfScope and the family
    // is reclassified as production, fills the ten slots, and truncates Hot.java
    // away — so the regression fails instead of shipping green. (integrationTest
    // is pinned by the dedicated test below.)
    const out = pathRulesFor([...noise, 'src/main/java/com/x/Hot.java']);
    const heading = out.split('\n').find((l) => l.startsWith('### ')) ?? '';
    expect(heading).toContain('Hot.java');
    expect(heading).toContain('…and 2 more');
    expect(heading).not.toContain(noise[noise.length - 1]);
  });

  it('treats a source package merely named generated as production', () => {
    // `src/main/java/com/x/generated/` is a source package that happens to be
    // named `generated`; only build OUTPUT dirs (target/generated-sources,
    // build/generated) are scoped out. Even with the cap full of real generated
    // sources, the production path must keep its named slot — if the generated
    // pattern over-matched, Proto.java would be scoped out and truncated away.
    const noise = Array.from(
      { length: 11 },
      (_, i) => `target/generated-sources/com/x/S${i}.java`,
    );
    const out = pathRulesFor([
      ...noise,
      'src/main/java/com/x/generated/Proto.java',
    ]);
    const heading = out.split('\n').find((l) => l.startsWith('### ')) ?? '';
    expect(heading).toContain('Proto.java');
    expect(heading).toContain('…and 2 more');
  });

  it('treats Gradle src/integrationTest as out of scope even past the cap', () => {
    // Gradle's conventional directory for an `integrationTest` suite is
    // src/integrationTest/java. With more than ten such paths plus one
    // production path, the production path must still be named first — not
    // truncated away by a heading full of test files.
    const tests = Array.from(
      { length: 12 },
      (_, i) => `src/integrationTest/java/com/x/T${i}.java`,
    );
    const out = pathRulesFor([...tests, 'src/main/java/com/x/Hot.java']);
    const heading = out.split('\n').find((l) => l.startsWith('### ')) ?? '';
    expect(heading).toContain('…and 3 more');
    expect(heading.indexOf('Hot.java')).toBeGreaterThanOrEqual(0);
    expect(heading.indexOf('Hot.java')).toBeLessThan(
      heading.indexOf('T0.java'),
    );
  });

  it('keeps the DoS escape hatch the workflow rule already needed', () => {
    // The flat "perf is a Suggestion" rule misfires on unbounded cost reachable
    // by an attacker — that is a security hole, not a nit. GITHUB_ACTIONS walked
    // back its own flat rule with a blast-radius carve-out; this one carries the
    // matching escape hatch from the start.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('cost is itself the wrongness');
    expect(out).toContain('denial-of-service');
  });

  it('names the split fast-path exception precisely', () => {
    // `split(".")` is single-character but "." is a regex metacharacter, so it
    // does NOT take the fast path. The parenthetical must say so, or the rule
    // teaches an agent to wave away a real per-call compile.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('metacharacter');
  });

  it('caps the triggering-path list in the heading', () => {
    // A workflow matches one or two files; a large Java PR matches hundreds, and
    // listing them all in the heading of every agent's brief is ~11 KB of a list
    // the agent already has. Name the first ten and a count.
    const many = Array.from(
      { length: 12 },
      (_, i) => `src/main/java/com/x/F${i}.java`,
    );
    const out = pathRulesFor(many);
    expect(out).toContain('…and 2 more');
    expect(out).toContain('src/main/java/com/x/F9.java');
    expect(out).not.toContain('src/main/java/com/x/F10.java');
    // At or under the cap, every path is still named.
    const few = many.slice(0, 10);
    const outFew = pathRulesFor(few);
    expect(outFew).not.toContain('…and');
    expect(outFew).toContain('src/main/java/com/x/F9.java');
  });

  it('names --release and the new-file clause in the static tier', () => {
    // The same source compiles to different bytecode at different --release
    // levels (37 vs 14 bytes for a five-+ concatenation), so measuring without
    // the project's target level produces a verdict on bytecode the artifact
    // does not contain. And a file the PR adds has no base side to compare.
    const out = pathRulesFor(['src/Main.java']);
    expect(out).toContain('--release');
    expect(out).toContain('maven.compiler.release');
    expect(out).toContain('no base side');
  });
});
