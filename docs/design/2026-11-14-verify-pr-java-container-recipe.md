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
  outside any boundary. These host-seeded directories are NOT valid seeds
  for the recipe: they were filled by PR code on the maintainer's machine,
  so the recipe uses its own `m2repo-sbx-<arm>` names and requires the
  pre-recipe directories to be removed before the first boundary seed.

## Goals

- A Java-heavy local round can run its compile, battery, and mutation matrix
  inside a credential-free boundary, with no host SSH keys, cloud profiles,
  `gh` token, or model keys visible.
- The boundary passes `verify-pr-prepare.mjs --require-isolation`
  (`QWEN_VERIFY_CREDENTIAL_FREE=1`, no credential signals).
- Runtime parity with ONE lane cell — the Linux Java 21 leg (Temurin 21,
  Maven 3.9.11). The lane runs the same job across five JDK/OS cells (Java
  11, 17, 21 on Ubuntu plus 21 on macOS/Windows); the 17 and 11 legs are out
  of the battery's scope and go to _Not covered_ unless the delta touches
  the SDK baseline (the `qwencode` SDK is held to Java 11). The battery
  image's `maven-compiler`/surefire target is stated in the round's report.

## Non-goals

- No MySQL/Hosted integration tier inside the boundary; those gates stay
  post-merge CI authority, as today.
- No change to the CI lane itself.
- No general-purpose multi-language image; Node-only rounds keep the existing
  recipe.

## Proposed solution

A second recipe in the skill, selected when the delta touches
`packages/sdk-java/` or `packages/managed-agent-server/` — the two paths
that carry the Java source. The CI lane's Java gate
(`managed-agent-gate-scope.mjs`) matches a broader set: it also fires on
`packages/cli/src/serve/`, `packages/core/src/managed-runtime/`, the hosted
integration helpers and the e2e scripts, which can break the Managed Agent
suite without touching Java source. A delta confined to those broader paths
keeps the JS recipe and leaves the Java tier to CI — the recipe does not
claim to mirror the gate's full trigger:

1. **Image.** A Maven image bundling the lane's Maven and JDK, such as
   `maven:3.9.11-eclipse-temurin-21`. Verify the exact tag exists at
   implementation time and pin by digest (the JS recipe references
   `node:22-bookworm` by tag; the Java recipe should be stricter). The
   **seed/gate** image must ALSO bundle a digest-pinned Node: the isolation
   gate is a Node program (`node /trusted-scripts/verify-pr-prepare.mjs
--require-isolation --artifact-dir …`), and the stock Maven image carries
   no Node, so a Java-only round could not produce the `boundary-gate.json`
   its `mode:"container"` declaration requires (R16-6). Run the seed and the
   gate in this one Maven+JDK+Node image (trusted scripts at
   `/trusted-scripts`), so the gate's `observed`/`credentialFree` attest the
   same container that executes the PR's Maven code. The offline **battery**
   image stays the stock Maven+JDK image (no Node needed for the battery);
   the "no Java+Node derivative" non-goal applies to the battery image, not
   the seed/gate image. If a model turn runs in a separate `node:22-bookworm`
   container, that container needs its own gate record too — one
   `boundary-gate.json` per PR-code-bearing container, each recording the
   container it observed. **Nonce binding (R16-1, #17371).** The gate record
   carries only `nonceSha256`; the plaintext lives in the gate container's
   `$HOME/.qwen-verify-nonce`, and the checker reads ONE record and ONE hash,
   refusing `mode:"container"` unless a round log carries a `container-nonce:`
   line whose sha256 matches. The per-container gate records are
   `checkBoundary` evidence only — they do not multiply the nonce binding. The
   `container-nonce:` line must be echoed by the container that runs the
   battery, reading that container's own `$HOME/.qwen-verify-nonce`. The
   offline battery runs in a different container than the seed/gate, so it
   cannot read the gate container's plaintext and cannot mint
   `mode:"container"`. Per the skill's step 5, a round whose battery cannot run
   in the gate container declares `mode:"waived"` with the maintainer's
   approval — a gate-container attestation is not a substitute for the
   battery's own boundary (R3-6).
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
   `<repositories>`/`<pluginRepositories>` from every pom, and the seed
   container's egress is restricted to the configured mirror by host
   firewall rules in BOTH the iptables `DOCKER-USER` (FORWARD) chain AND
   INPUT-chain rules on the bridge interface, with the mirror reachable
   through a sidecar/forward proxy that **denies by default and allowlists
   only the mirror**. An internal-only seed network (`docker network create
   --internal`) is NOT sufficient on its own: `--internal` drops FORWARD
   (off-subnet) traffic, but a packet from the seed to the host's own
   bridge-gateway address on that subnet is delivered locally via INPUT and
   answered by a host service — so option A still needs the INPUT-chain rule
   to block host-bound listeners (including the host-side model proxy when
   it binds the bridge gateway). `DOCKER-USER` alone filters only FORWARD,
   so it cannot stop the seed reaching a service on the host itself. Docker
   itself has no egress-allowlist feature, and Maven settings cannot bound
   code executing inside the project lifecycle, so the containment must
   name the layer that actually enforces it, in both directions, and the
   sidecar must not be an open CONNECT forwarder (no allowlist = reachable
   everything). The seed
   FIRST installs the one SDK module the lane and the consumer actually use,
   `packages/sdk-java/qwencode` (`mvn install -DskipTests -Dgpg.skip=true
-Dmaven.javadoc.skip=true` on that module's pom, as the CI lane does
   inside its own job boundary; `packages/sdk-java` has no root reactor, and
   the managed-agent build resolves `qwencode-sdk` only), THEN runs
   `mvn dependency:go-offline` against the consumer's poms: the managed-agent
   build resolves the SDK from the local repo, so a fresh seed without it
   cannot resolve, go-offline must see the installed jar, and a reused seed
   with a stale one compiles against the wrong jar. The reuse key is one
   rule everywhere in this recipe: **reuse a seeded repository only when
   the pom set, the SDK sources, the arm (head vs base), and the
   seeded-inside-a-boundary provenance are all unchanged**; a change to any
   re-seeds, under the same built-for-this-head reuse rule the skill applies
   to installs and builds, and a re-seed starts from an EMPTY
   `m2repo-sbx-<arm>` directory — seeding into the old one would leave
   earlier heads' artifacts resolvable, and an offline battery could pass
   where a fresh seed fails. The recipe uses its OWN directory names,
   `m2repo-sbx-head` and `m2repo-sbx-base`, distinct from the pre-recipe
   host-seeded `m2repo-head`/`m2repo-prev`: a host-seeded directory is NOT a
   valid seed (it was filled by PR code on the maintainer's machine) and
   must be removed before the first boundary seed; each boundary seed
   writes a `seed.json` marker (`credentialFree: true` plus the seed run's
   gate record), and a directory without it is treated as absent. The head
   seed installs the head's SDK jar, the base seed the base's, each built
   from that side's sanitized copy — a single shared seed would let the
   trusted base arm resolve the head-built jar and hide any regression the
   jar carries. `.mvn/` is deliberately NOT a reuse-key
   dimension: the strip list always removes it, so a `.mvn/` change cannot
   affect the seed; a PR that edits `.mvn/` gets a seed jar built without
   that config, and the round records the deviation instead of re-seeding
   byte-identical output.
   Seed with the lane's Maven 3.9.11 defaults — do NOT pass
   `-Dmaven.legacyLocalRepo=true`: Maven 3.9 refuses that flag. The seed's
   `_remote.repositories` provenance markers record which mirror served
   each artifact; the copy-out is restricted to the paths the seed's own
   SDK install and `dependency:go-offline` wrote (a before/after manifest
   of the repository tree), verified against the resolved tree, and the
   manifest records each artifact's serving mirror so provenance survives
   the next step: the copy-out STRIPS the `_remote.repositories` markers
   afterwards, AND the same mutable resolver state the lane prunes —
   `*.lastUpdated`, `resolver-status.properties`, `maven-metadata-*.xml*`,
   `*.part`, `*.part.lock`, `*.tmp` — so a missed lookup cannot ride into
   the battery as a negative-cache entry that suppresses re-resolution
   (the manifest records them as excluded). The copy-out, like the copy-in,
   does NOT dereference symlinks (`docker cp` reproduces them as links): a
   PR plugin could leave a jar as a symlink with an absolute host target
   (`/root/.ssh/id_rsa`), and a later dereferencing pass on the host would
   write credential content into the artifact tree — so the copy-out is
   verified against the resolved tree WITHOUT following links out of the
   tree, and any escaping symlink is refused. The battery mounts no
   `settings.xml`, so the seed's mirror id has no counterpart there;
   leaving the markers in place would make offline resolution reject
   artifacts whose recorded repository is absent from the battery's
   configuration.
   Residual risk, stated rather than hidden: a PR build plugin executing
   during the seed can still install a doctored jar at a real dependency's
   coordinates inside the seed container, and the manifest cannot attribute
   authorship — the containment is the mirror-only egress plus the base
   arm's independent seed, not a proof that every jar is mirror-fetched.
   The battery container mounts its arm's seeded repository **read-only** —
   never `settings.xml`, which can carry mirror credentials — and runs with
   `-o -Dmaven.repo.local=/m2 --network none` — stricter than the JS recipe,
   which keeps network for the model proxy, because the Java battery needs
   no model access. The `-o` (offline) flag is what turns a seed gap into a
   resolution error naming the coordinate ("could not resolve X in module
   Y — re-seed it"); `--network none` alone is the containment, not the
   offline switch, and without `-o` a missed artifact surfaces as transport
   noise plus read-only write-failure warnings instead. A row that must write (a mutation installing a mutated
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
   battery itself needs no model access. The containers are driven by an
   **operator-owned host relay**: the host runs `docker exec` into the
   battery container on the round's behalf and returns the output. The
   relay's contract is fixed on the operator side, never taken from a
   request: the container name and all flags come from the relay's own
   configuration; the command is passed as an argv array with no shell
   between it and `docker exec`; requests naming another container or
   carrying `--privileged`, `--pid`, `--net`, `--volume`, or `--user` are
   refused; the listener binds to the bridge/loopback address with a
   per-round token. (Alternatively the operator types the `docker exec`
   lines directly, which keeps the socket on the trusted side.) The
   round never receives the Docker socket — that would hand untrusted PR
   code host-root while `--require-isolation` still exits 0 (the gate
   inspects environment and credential signals, not sockets).
4. **Declaration.** The operator writes the declaration after the gate
   passes — the same operator-owned rule as the JS recipe, not the round
   itself. The gate run (`--require-isolation --artifact-dir <round-dir>`)
   writes the `boundary-gate.json` record in the seed container. Because the
   offline battery runs in a _separate_ container that cannot read the seed
   container's `$HOME/.qwen-verify-nonce`, it cannot echo a `container-nonce:`
   line hashing to the gate record's `nonceSha256` (step 1), so the round
   declares `mode:"waived"` with the maintainer's approval — not
   `mode:"container"` (R4-2). The declaration carries `by` (the maintainer),
   `reason`, and an `approval` permalink, and names **every** container the
   round uses in `detail` — including the seed container, the only one with
   outbound egress and the one in which PR-authored Maven plugins execute: the
   seed container (mirror-only egress), the offline battery container, and,
   when the round uses a model, the proxy-connected container that runs the
   model turns, each with its image and network policy, e.g.
   `{"mode":"waived","by":"<maintainer>","reason":"Java battery runs in a separate offline container that cannot echo the seed gate's nonce","approval":"https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>","detail":"seed: maven:3.9.11-eclipse-temurin-21, mirror-only egress; battery: same image, --network none, offline m2; model turns: node:22-bookworm via host proxy; credential-free"}`.
   A round with no model turns names the seed and battery containers; the
   declaration is incomplete if it omits the seed.

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
  runtime and grows the image the round must trust. The offline **battery**
  image stays the stock Maven+JDK image (no Node needed to run the battery),
  and a general Java+Node battery derivative is a declared non-goal; a mixed
  round runs its JS suites in the JS recipe's container and its Java battery
  in this one, sharing the artifact directory through the host. The
  **seed/gate** image is the exception: it bundles a digest-pinned Node so
  the Node-based isolation gate can run in the same container that seeds the
  PR's Maven code (R16-6) — that is a gate requirement, not a general
  multi-language battery image.

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
  `maven.config` alike. It also handles pom-declared build extensions
  (`<build><extensions>`, and any `<plugin>` with
  `<extensions>true</extensions>`) that are EFFECTIVE in the seeded model —
  a `<plugin>` in `<build><plugins>` not inside an inactive profile. The
  refusal is scoped to effective extensions only: the SDK pom this recipe
  installs (`packages/sdk-java/qwencode/pom.xml`) declares
  `central-publishing-maven-plugin` with `<extensions>true</extensions>` in
  its active build, and the lane loads it successfully, so a blanket refusal
  would reject the very pom the seed exists for. Because the seed runs
  inside the credential-free, mirror-only-egress container — where a model
  extension is contained exactly like the lifecycle-bound executions the
  recipe already accepts — an effective extension is RECORDED in the
  copy-out manifest rather than refused outright; only an extension that
  would reach an arbitrary host (combined with a stripped
  `<repositories>`/`<pluginRepositories>`) is refused. The sanitizer is
  section-aware: `packages/managed-agent-server/pom.xml` declares the same
  plugin inside the inactive `central-release` profile, which is not
  effective and is left alone. Lifecycle-bound `<build><plugins>`
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
  in-boundary write stays inside the container. Each fixture has its OWN
  expected outcome, because the strip list can remove the build extension
  but deliberately cannot remove a lifecycle-bound execution:
  - Build-extension fixture: run the UNSANITIZED copy first and assert the
    positive witness (marker present inside the container, absent from the
    host copy — the write path fired and copy-in contained it); then run the
    sanitized copy and assert NO marker inside the container — the strip
    removed the trigger.
  - Lifecycle-bound `<build><plugins>` fixture: the marker IS present inside
    the seed container in BOTH stages (the execution cannot be stripped) and
    absent from the host copy in both — this is the positive control for the
    boundary's containment, not for the strip list. Asserting "no marker
    inside" for this fixture would be unsatisfiable by design.
- Positive control (sanitizer): the two real repo poms —
  `packages/sdk-java/qwencode/pom.xml` (active extension) and
  `packages/managed-agent-server/pom.xml` (inactive-profile extension) —
  pass the sanitizer and seed successfully, proving the refusal is scoped to
  effective extensions and does not reject the pom the recipe exists for.

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
