# Managed preflight security-semantics redesign (Slice 6, remaining sub-items)

[English](2026-11-17-managed-preflight-security-redesign.md) | [简体中文](2026-11-17-managed-preflight-security-redesign.zh-CN.md)

## Status and scope

Self-contained implementation plan for the three remaining sub-items of Slice 6 (preflight simplification) in `docs/design/2026-11-12-managed-agent-preproduction-convergence.md`. The fourth sub-item — canonical Broker URL entry — already landed as commit `7b345783717` on branch `refactor/managed-agent-preflight-simplification` (Java `HarnessBrokerUrl` now uses `InetAddress` canonicalization plus a canonical-shape gate; the Node resolver `packages/cli/src/serve/managed-runtime-broker-url.ts` applies the same gate; both share one updated fixture set).

The three sub-items below all touch security semantics and are pinned by large exact-verdict test suites. They are redesigns, not quick wins. Do them one at a time, each as its own clean commit (and ideally its own PR), keeping the pinned suites green at every commit. Do not batch them into one large diff.

Work in this same worktree directory in a NEW session (do not `--resume` the large originating session); read this document and start. Verify every line anchor against the current tree before editing — line numbers drift.

## Baseline and local verification

JDK 21 and Maven >= 3.8.9. Use a task-isolated Maven repository and install the sibling SDK from this checkout first:

```
# Plain copy works everywhere; prefer a copy-on-write clone when available:
#   macOS (APFS): cp -Rc ~/.m2/repository /tmp/preflight-m2
#   Linux (GNU):  cp -R --reflink=auto ~/.m2/repository /tmp/preflight-m2
cp -R ~/.m2/repository /tmp/preflight-m2
mvn -Dmaven.repo.local=/tmp/preflight-m2 -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
```

Run focused Java tests from `packages/managed-agent-server` with `-Dmaven.repo.local=/tmp/preflight-m2`, and always both Checkstyle executions (`checkstyle:check checkstyle:check@runtime-broker-checkstyle`). The pinned suites for this work are `ServerEnvironmentTest`, `ManagedAgentPreflightTest`, `ServiceAccountTest`, `ResolvedConfigurationTest`, `ExternalRuntimeConfigurationTest` (all under `verification/src/test/java/com/alibaba/qwen/code/managedagent/preflight/`). Some `ManagedAgentPreflightTest` cases spawn real Node workers and need built `packages/core/dist` and `packages/cli/dist`; build those (`npm run build`) before selecting such cases, or leave them to CI and say so. Full gates (unit/H2, SpotBugs, MySQL, Hosted) belong to CI; report local pass/fail/skip and CI gaps separately. Acceptance is pending until the required CI gates pass.

## Sub-item A — replace StackWalker format sniffing with Spring ConfigData

Current anchor: `ServerEnvironment.java` `reader(Path)` uses `StackWalker.getInstance(RETAIN_CLASS_REFERENCE)` to identify which `PropertySourceLoader` opens a file, recording formats into the `LookedUp` property source; `prepare()` installs that loader. The discovered files/formats feed `files()`, `configurationFiles()`, `sourceFiles()`, `sourceConfigurations()`, `hidden()` and `failure()`.

Goal: derive the same "which files Spring looked up (including absent ones) and in which formats" information from Spring's ConfigData API / loaded property-source origins instead of stack sniffing, without changing any observable verdict.

Constraints: `ServerEnvironmentTest` pins exact file lists, format sets, profile variants, wildcard/configtree expansion, hidden-directory detection and failure messages (including unreadable-file and YAML line/column wording). Every one of those pins must stay green. If ConfigData cannot reproduce a pin (for example files Spring looked up but did not load), keep the existing `LookedUp` mechanism for that part rather than dropping the pin.

Acceptance: `ServerEnvironmentTest` fully green; both Checkstyle executions clean; no behavior change in `--check` config rows.

## Sub-item B — remove the YAML/comment AST while keeping value-based secret detection

Current anchor: `ManagedAgentPreflight.java` `YamlWalk` (SnakeYAML node walk) plus `yamlSecret`, `commentSecret`, `comments()`, `holdsSecret`, `declaresSecret`. Value-based detection lives in `valueSecret` (URL user-information password and `?password=`/`?token=` parameters under any key) and `secretProperty` (key-name suffixes).

Goal: delete the SnakeYAML AST walk and the comment/path machinery, replacing them with a simpler scanner that still flags (1) any value holding a secret (URL userinfo, `?password=`/`?token=`), (2) any declared key naming a secret, and (3) a commented-out setting that would name or hold a secret if uncommented. A key-name-only scan is NOT acceptable: it would miss a credential inside e.g. `spring.datasource.url` and lose the `chmod 600` warning (locked constraint R1-5 from the #17139 review).

Constraints: `ServerEnvironmentTest.readsACommentAsTheSettingItWouldBeUncommented` and `judgesWhatACommentHoldsHoweverItIsWritten` pin ~100 exact WARN/PASS verdicts across YAML/properties/XML, complex YAML keys, sets, pairs, merges, aliases, UTF-16/BOM, escaped markers and prose. The replacement must reproduce every verdict, including the PASS cases for prose and for empty/unbound containers. Prefer reusing Spring's own property-source loaders to flatten YAML/properties/XML (as `declaresSecret` already does for properties/XML) plus the existing `valueSecret`/`WRITTEN_SETTING` comment heuristic, over hand-rolling a new parser.

Acceptance: both pinned test methods fully green; `ManagedAgentPreflightTest` secret-file cases green; both Checkstyle executions clean; `chmod 600` warning preserved.

## Sub-item C — test ServiceAccount access as the service identity

Current anchor: `ServiceAccount.java` `can()`/`allows()` simulate POSIX owner/group/other bits and symlink traversal (max 40 links) in user space, because preflight often runs as root and must judge access for a different configured service account. `lookup()` shells out to `id`.

Goal: judge file access as the actual service identity rather than a root user-space `namei` simulation, per the Slice 6 design.

Constraints and caution: `ServiceAccountTest` pins owner/group/other precedence, directory-enter vs read, symlink traversal on both sides of a link, the 40-link limit, missing-file and loop behavior, and root semantics. A real-identity check generally requires running the probe as that uid (only root can drop privileges), which is platform-specific and may not be possible for a non-root operator. Decide and document the fallback: when the process cannot assume the service identity, keep the existing simulation (it is the only portable answer) rather than silently returning a wrong verdict. Do not weaken the pinned assertions to make a new implementation pass.

Acceptance: `ServiceAccountTest` fully green on macOS and Linux; both Checkstyle executions clean; the unreadable-file / hidden-directory config rows keep their current wording.

## Sequencing and cross-cutting rules

Do A, then B, then C (A is the most mechanical, C the most platform-sensitive); each is independently shippable. Keep the bilingual convergence design doc synchronized whenever a sub-item lands (mark it Done in both languages). Preserve all category-C invariants and the module AGENTS.md review rules. Never disable a gate or delete a pin to make verification pass; if a pin cannot be preserved, stop and surface the conflict instead of landing a red or weakened state.
