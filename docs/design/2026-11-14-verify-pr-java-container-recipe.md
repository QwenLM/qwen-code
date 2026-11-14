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
`packages/managed-agent-server/`:

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
   whose egress is limited to the configured mirror**, with a
   credential-free mirror configuration; the resulting repository is copied
   out. The seed runs `mvn dependency:go-offline` and installs the PR's
   `packages/sdk-java` reactor artifacts (`mvn install -DskipTests
-Dgpg.skip=true -Dmaven.javadoc.skip=true` on the SDK modules, as the CI
   lane does inside its own job boundary): the managed-agent build resolves
   them from the local repo, so a fresh seed without them cannot resolve,
   and a reused seed with stale ones compiles against the wrong jar. The
   reuse key is one rule everywhere in this recipe: **reuse the seeded
   repository only when the pom set and the SDK sources are both
   unchanged**; a change to either re-seeds, under the same
   built-for-this-head reuse rule the skill applies to installs and
   builds. Strip the `_remote.repositories`
   tracking files afterwards (or seed with `-Dmaven.legacyLocalRepo=true`):
   they record which mirror served each artifact, and offline resolution
   against a different repo id otherwise re-resolves and fails. The battery
   container mounts that repository directory only — never `settings.xml`,
   which can carry mirror credentials — and runs with
   `-Dmaven.repo.local=/m2 --network none` — stricter than the JS recipe,
   which keeps network for the model proxy, because the Java battery needs
   no model access. Offline resolution keeps the credential-free boundary
   intact: no network means no exfiltration path and no mirror auth inside.
3. **Trusted scripts, PR clone, model proxy.** Same layout as the JS recipe:
   scripts come from the trusted clone, the round runs in a standalone PR
   clone, and any model-driven step goes through the host-side
   `verify-pr-model-proxy.mjs` relay. The offline battery container cannot
   reach that proxy, so the round's own model turns run in a separate
   proxy-connected container (the JS recipe's shape) or not at all; the
   battery itself needs no model access.
4. **Declaration.** The operator writes the declaration after the gate
   passes — the same operator-owned rule as the JS recipe, not the round
   itself. It names **both** containers when the round uses two: the
   offline battery container and the proxy-connected container that runs
   the model turns, each with its image and network policy, e.g.
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
  per round (minutes, cached across rounds of the same PR by reusing the
  repository directory when the pom set and the SDK sources are both
  unchanged — the same reuse rule the skill already applies to installs
  and builds).
- **Bundled image over JDK-on-node.** Layering a JDK onto `node:22-bookworm`
  would serve mixed PRs in one container, but drifts from the CI lane's
  runtime and grows the image the round must trust. Mixed rounds can run the
  JS suites in the Java image (it carries Node via a pinned install) or in
  two containers; that choice is left to the implementation.

## Constraints

- The container sees no host credentials; the mounted repository is
  dependency jars only.
- `--require-isolation` must exit 0 inside; a container marker alone does not
  pass (existing rule).
- No host step executes PR code — not even "resolution only": the host
  prepares the sanitized copy and copies the repository out, and every
  Maven goal against the PR's poms runs inside the seed container. The
  sanitized copy removes the **whole `.mvn/` directory**: the launcher
  honours core extensions, `jvm.config` (concatenated into `MAVEN_OPTS`
  before the JVM starts — a `-javaagent:` there runs during the seed), and
  `maven.config` alike. It also refuses pom-declared build extensions
  (`<build><extensions>`, and any `<plugin>` with
  `<extensions>true</extensions>`, in the root and every module pom), which
  resolve and load while the project model is built — before any goal runs.
  Lifecycle-bound `<build><plugins>` executions cannot be enumerated, which
  is why the seed runs inside the boundary rather than on the host. The
  trusted mirror settings stay host-side; the seed container gets a
  credential-free mirror configuration, never the host's `settings.xml`.

## Risks

- **Incomplete seeding.** `dependency:go-offline` misses plugins resolved
  lazily; the offline build then fails mid-round. Mitigation: fail loud,
  re-seed from the failing module, and record the gap under _Not covered_
  until resolved — never fall back to host execution silently.
- **Repository reuse staleness.** A reused repository built for another head
  can mask a dependency change, and stale SDK jars compile against the wrong
  code. Mitigation: the skill's existing built-for-this-head reuse rule
  applies with the single reuse key above — the pom set and the SDK sources
  must both be unchanged; a change to either re-seeds.
- **Image drift.** Digest pinning plus a documented refresh step.

## Validation plan

- One live Java-heavy round (a `managed-agent-server` PR) runs compile +
  battery + at least one mutation inside the recipe; the gate exits 0 and
  `boundary.json` records container mode.
- A/B parity: the same battery's counts match a host run of the same head
  (the recipe changes the boundary, not the measurements).
- Negative control: `--require-isolation` still exits 4 outside the boundary.
- Negative control (seed): a fixture pom whose build extension writes a
  marker file when loaded, and a second fixture whose `<build><plugins>`
  execution bound to `compile` writes one; the documented seed procedure
  must leave no marker on the host for either.

## Acceptance criteria

- The skill carries the Java recipe with the same trusted-clone / PR-clone /
  proxy layout as the JS recipe.
- A Java round can complete without any host execution of PR code, and its
  report's `**Boundary.**` line names every container the round used, each
  with its image and network policy.
- The waiver path remains available and recorded for rounds that cannot use
  the recipe (e.g. a database-dependent repro).

## Open questions

- Mixed Java + JS rounds: one container with Node installed, or two
  containers sharing the artifact directory?
- Does the seed step belong in `verify-pr-prepare.mjs` (host side) or in a
  separate recipe script?
