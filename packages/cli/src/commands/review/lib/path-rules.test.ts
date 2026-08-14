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
