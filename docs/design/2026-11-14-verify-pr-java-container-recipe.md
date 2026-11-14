# /verify-pr Java container recipe

[English](2026-11-14-verify-pr-java-container-recipe.md) | [简体中文](2026-11-14-verify-pr-java-container-recipe.zh-CN.md)

**Status: proposal.** The boundary declaration (`boundary.json`, checker
enforcement, the recorded host waiver) ships with this change; the container
recipe below is the follow-up work it names.

## Problem

`/verify-pr` executes untrusted PR code and requires the same isolation CI
provides: a credential-free container or VM. The skill's local Docker recipe
uses `node:22-bookworm`, which carries no JDK and no Maven. A round on a
Java-heavy PR (anything under `packages/managed-agent-server/`) therefore has
no ready container in the local recipe. The sandboxed CI lane already
provisions Temurin JDK 21 + Maven 3.9.11 for diffs touching
`packages/sdk-java/` or `packages/managed-agent-server/`; what is missing is
the local path.

Measured consequence: two consecutive local rounds on PR #16866 (r10, r11)
ran the entire Java battery, mutation matrix, and JS suites on the
maintainer's host — no `--require-isolation`, no container, no waiver, and no
boundary line in either report. The prose rule alone did not stop the silent
fallback. This change makes the fallback visible (the checker refuses a round
without `boundary.json`); this design removes the reason for it.

## Current state

- The CI `SDK Java` lane (`.github/workflows/sdk-java.yml`) runs on Temurin
  JDK (matrix `java`), Maven `3.9.11`, a job-local Maven repository
  (`-Dmaven.repo.local`), and a configured mirror
  (`.github/scripts/configure-maven-mirror.sh`). It is the runtime the local
  recipe should sample, per the skill's "live sample of the lane's own
  runtime" rule.
- The local JS recipe runs `node:22-bookworm` with no host credentials
  mounted, reaching a host-side per-round bearer model proxy over the
  Docker bridge; its boundary is credential-free, not offline.
- Local Java rounds today reuse a host-seeded per-arm Maven repository
  (`m2repo-head`, `m2repo-prev`) and the host's JDK 21 + Maven — fast, but
  outside any boundary.

## Goals

- A Java-heavy local round can run its compile, battery, and mutation matrix
  inside a credential-free boundary, with no host SSH keys, cloud profiles,
  `gh` token, or model keys visible.
- The boundary passes `verify-pr-prepare.mjs --require-isolation`
  (`QWEN_VERIFY_CREDENTIAL_FREE=1`, no credential signals).
- Runtime parity with the CI lane: Temurin 21, Maven 3.9.11.

## Non-goals

- No MySQL/Hosted integration tier inside the boundary; those gates stay
  post-merge CI authority, as today.
- No change to the CI lane itself.
- No general-purpose multi-language image; Node-only rounds keep the existing
  recipe.

## Proposed solution

A second recipe in the skill, selected when the delta touches
`packages/sdk-java/` or `packages/managed-agent-server/` — the same two
paths the CI lane's Java gate matches:

1. **Image.** A Maven image bundling the lane's Maven and JDK, such as
   `maven:3.9.11-eclipse-temurin-21`. Verify the exact tag exists at
   implementation time and pin by digest (the JS recipe references
   `node:22-bookworm` by tag; the Java recipe should be stricter).
2. **Offline Maven repository, seeded inside a boundary.** No host step runs
   a Maven goal against the PR's poms: `mvn install` walks the whole default
   lifecycle, so any plugin execution the PR binds to `compile` or `test`
   would run on the maintainer's machine — the strip list below covers
   project-model extensions, not lifecycle-bound `<build><plugins>`
   executions. Instead, the host prepares a sanitized copy of the PR tree
   (strip list below) and the **seed runs inside a credential-free container
   whose egress is limited to the configured mirror**; the resulting
   repository is copied out. Mirror-only egress is enforced, not assumed:
   the seed's settings use `<mirrorOf>*</mirrorOf>` (the lane's
   `<mirrorOf>central</mirrorOf>` does not redirect a pom-declared
   `<repositories>` entry), the strip list removes
   `<repositories>`/`<pluginRepositories>` from every pom, and the container
   runs with a network-level mirror allowlist — Maven settings cannot bound
   code executing inside the project lifecycle, so the containment lives at
   the Docker layer. The seed runs `mvn dependency:go-offline` and installs
   the one SDK module the lane and the consumer actually use,
   `packages/sdk-java/qwencode` (`mvn install -DskipTests -Dgpg.skip=true
-Dmaven.javadoc.skip=true` on that module's pom, as the CI lane does
   inside its own job boundary; `packages/sdk-java` has no root reactor, and
   the managed-agent build resolves `qwencode-sdk` only): the managed-agent
   build resolves it from the local repo, so a fresh seed without it cannot
   resolve, and a reused seed with a stale one compiles against the wrong
   jar. The reuse key is one rule everywhere in this recipe: **reuse a
   seeded repository only when the pom set, the SDK sources and the arm
   (head vs base) are all unchanged**; a change to any re-seeds, under the
   same built-for-this-head reuse rule the skill applies to installs and
   builds. There are **two** seeded repositories, `m2repo-head` and
   `m2repo-base`: the head seed installs the head's SDK jar, the base seed
   the base's, each built from that side's sanitized copy — a single shared
   seed would let the trusted base arm resolve the head-built jar and hide
   any regression the jar carries. `.mvn/` is deliberately NOT a reuse-key
   dimension: the strip list always removes it, so a `.mvn/` change cannot
   affect the seed; a PR that edits `.mvn/` gets a seed jar built without
   that config, and the round records the deviation instead of re-seeding
   byte-identical output.
   Seed with `-Dmaven.legacyLocalRepo=true` and KEEP the
   `_remote.repositories` provenance markers: they record which mirror
   served each artifact, and the copy-out is restricted to the paths the
   seed's own `dependency:go-offline` and SDK install wrote (a before/after
   manifest of the repository tree), verified against the resolved tree.
   Residual risk, stated rather than hidden: a PR build plugin executing
   during the seed can still install a doctored jar at a real dependency's
   coordinates inside the seed container, and the manifest cannot attribute
   authorship — the containment is the mirror-only egress plus the base
   arm's independent seed, not a proof that every jar is mirror-fetched.
   The battery container mounts its arm's seeded repository **read-only** —
   never `settings.xml`, which can carry mirror credentials — and runs with
   `-Dmaven.repo.local=/m2 --network none` — stricter than the JS recipe,
   which keeps network for the model proxy, because the Java battery needs
   no model access. A row that must write (a mutation installing a mutated
   SDK jar) gets its own copy of the repository and its own
   `-Dmaven.repo.local`, as the skill's mutation rules already require; a
   writing round invalidates the reuse key, so the shared seed never holds
   a mutant jar. Offline resolution keeps the credential-free boundary
   intact: no network means no exfiltration path and no mirror auth inside.
3. **Trusted scripts, PR clone, model proxy.** Same layout as the JS recipe:
   scripts come from the trusted clone, the round runs in a standalone PR
   clone, and any model-driven step goes through the host-side
   `verify-pr-model-proxy.mjs` relay. The offline battery container cannot
   reach that proxy, so the round's own model turns run in a separate
   proxy-connected container (the JS recipe's shape) or not at all; the
   battery itself needs no model access. The two containers are driven by an
   **operator-owned host relay**: the host runs `docker exec` into the
   battery container on the round's behalf and returns the output. The
   round never receives the Docker socket — that would hand untrusted PR
   code host-root while `--require-isolation` still exits 0 (the gate
   inspects environment and credential signals, not sockets).
4. **Declaration.** The operator writes the declaration after the gate
   passes — the same operator-owned rule as the JS recipe, not the round
   itself. The gate run (`--require-isolation --artifact-dir <round-dir>`)
   writes the `boundary-gate.json` record the checker requires alongside a
   container declaration. It names **both** containers when the round uses
   two: the offline battery container and the proxy-connected container
   that runs the model turns, each with its image and network policy, e.g.
   `{"mode":"container","detail":"battery: maven:3.9.11-eclipse-temurin-21, --network none, offline m2; model turns: node:22-bookworm via host proxy; credential-free"}`.
   A round with no model turns names the battery container alone.

## Design decisions and rationale

- **Seed inside a boundary, battery offline.** The seed needs the mirror,
  so it runs in a credential-free container with mirror-only egress — an
  egress allowlist is a second trust surface (DNS, redirects, mirror
  compromise), which is why it is confined to the seed and the battery
  itself runs with `--network none` against the copied-out repository. The
  host never runs a goal against PR poms: lifecycle-bound plugin executions
  are PR code too, and no strip list can enumerate them. Cost: a seed step
  per round per arm (minutes, cached across rounds of the same PR by reusing
  the arm's repository directory when the pom set and the SDK sources are
  unchanged — the same reuse rule the skill already applies to installs
  and builds).
- **Bundled image over JDK-on-node.** Layering a JDK onto `node:22-bookworm`
  would serve mixed PRs in one container, but drifts from the CI lane's
  runtime and grows the image the round must trust. The stock Maven+JDK
  image carries no Node, and a Java+Node derivative is a declared non-goal;
  a mixed round runs its JS suites in the JS recipe's container and its Java
  battery in this one, sharing the artifact directory through the host.

## Constraints

- The container sees no host credentials; the shared seeded repository is
  dependency jars only, mounted read-only — a writing row uses its own copy
  (see step 2), so the shared seed never holds a round-installed artifact.
- `--require-isolation` must exit 0 inside; a container marker alone does not
  pass (existing rule).
- No host step executes PR code — not even "resolution only": the host
  prepares the sanitized copy and copies the repository out, and every
  Maven goal against the PR's poms runs inside the seed container. The
  sanitized copy is made **without dereferencing symlinks** (`cp -a` /
  `rsync -a`, never `-L`), and any symlink whose target escapes the tree is
  refused: a dereferencing copy would write host file content into a tree
  that is then mounted into a container with PR-authored Maven code in it.
  The copy removes the **whole `.mvn/` directory**: the launcher honours
  core extensions, `jvm.config` (concatenated into `MAVEN_OPTS` before the
  JVM starts — a `-javaagent:` there runs during the seed), and
  `maven.config` alike. It also refuses pom-declared build extensions
  (`<build><extensions>`, and any `<plugin>` with
  `<extensions>true</extensions>`, in the root and every module pom), which
  resolve and load while the project model is built — before any goal runs,
  and strips `<repositories>`/`<pluginRepositories>` so a PR pom cannot
  point the seed at an arbitrary host. Lifecycle-bound `<build><plugins>`
  executions cannot be enumerated, which is why the seed runs inside the
  boundary rather than on the host. The trusted mirror settings stay
  host-side; the seed container gets a credential-free mirror configuration
  with `<mirrorOf>*</mirrorOf>`, never the host's `settings.xml`.

## Risks

- **Incomplete seeding.** `dependency:go-offline` misses plugins resolved
  lazily; the offline build then fails mid-round. Mitigation: fail loud,
  re-seed from the failing module, and record the gap under _Not covered_
  until resolved — never fall back to host execution silently.
- **Repository reuse staleness.** A reused repository built for another head
  can mask a dependency change, and stale SDK jars compile against the wrong
  code. Mitigation: the skill's existing built-for-this-head reuse rule
  applies with the single reuse key above — the pom set, the SDK sources and
  the arm must all match; a change to any re-seeds, and a writing round
  invalidates the key outright. The base arm never resolves the head seed.
- **Seed provenance.** A PR build plugin running during the seed can install
  a doctored jar at a real dependency's coordinates; the copy-out manifest
  restricts what leaves the seed but cannot attribute authorship. Mitigation:
  mirror-only egress, the base arm's independent seed, and the residual risk
  recorded under _Not covered_ — never a claim that every jar is
  mirror-fetched.
- **Image drift.** Digest pinning plus a documented refresh step.

## Validation plan

- One live Java-heavy round (a `managed-agent-server` PR) runs compile +
  battery + at least one mutation inside the recipe; the gate exits 0 and
  `boundary.json` records container mode.
- A/B parity: the same battery's counts match a baseline run of the same
  head (the recipe changes the boundary, not the measurements). A host
  baseline is itself a `waived` round with the maintainer's approval recorded
  — the checker refuses any other mode for host execution — or the baseline
  runs inside the boundary too.
- Negative control: `--require-isolation` still exits 4 outside the boundary.
- Negative control (seed): a fixture pom whose build extension writes a
  marker file when loaded, and a second fixture whose `<build><plugins>`
  execution bound to `compile` writes one. The sanitized copy reaches the
  seed container by **copy-in** (`docker cp`), not a bind mount, so an
  in-boundary write stays inside the container: the control asserts no
  marker in the host copy, which a bind mount would make indistinguishable
  from a phantom host execution.

## Acceptance criteria

- The skill carries the Java recipe with the same trusted-clone / PR-clone /
  proxy layout as the JS recipe.
- A Java round can complete without any host execution of PR code, and its
  report's `**Boundary.**` line names every container the round used, each
  with its image and network policy.
- The waiver path remains available and recorded for rounds that cannot use
  the recipe (e.g. a database-dependent repro).

## Open questions

- Does the seed step belong in `verify-pr-prepare.mjs` (host side) or in a
  separate recipe script?
