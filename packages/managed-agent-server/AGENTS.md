# Managed Agent Server

These instructions apply to this directory and its descendants. They supplement
the [repository AGENTS.md](../../AGENTS.md); its simplicity, design,
self-audit, and PR requirements still apply. When changing another module,
also read the instructions that apply there.

## Scope and References

This is the standalone Spring Boot control plane for the Hosted Harness. Keep
DataWorks and other product-specific integrations outside this module. Preserve
the ownership boundary between control-plane lifecycle state, Runtime Broker
execution bindings, and Hosted Harness execution.

Use the [README](README.md) for setup, authentication, deployment, and test
profiles. Keep detailed procedures there rather than duplicating them here.

## Library Reuse

- Prefer JDK APIs and the declared Apache Commons libraries over new generic
  helpers. Use `org.apache.commons.lang3.StringUtils` for null-safe blank checks
  and truncation; do not introduce another string utility class or wrappers
  that only repeat those operations.
- Use Commons Codec `DigestUtils` for raw SHA-256 operations and
  `getSha256Digest()` for incremental digest initialization. Keep streaming
  limits, heartbeat checks, and length-prefixed inputs intact. Use `HmacUtils`
  for HMAC with a fresh instance per call; preserve signature input bytes,
  output encoding, constant-time comparisons, and exception mappings.
- Use `StringUtils.isNumeric` when the existing validation accepts Unicode
  digits. Keep ASCII-only protocol checks explicit.
- Preserve UTF-8 encoding, digest prefixes, and the existing JSON
  canonicalization rules.
- Preserve domain-specific semantics: title `unicodeBlank` also recognizes
  NBSP and BOM, so it is not interchangeable with `StringUtils.isBlank`.
- Reuse fully configured `ObjectMapper` instances and inject existing Spring
  components rather than constructing them for each call. Keep protocol JSON
  configuration fixed; application-wide mapper settings must not change stored
  bytes or digests.
- Declare directly used libraries in this module's POM. Let Spring Boot manage
  their versions rather than relying on sibling or storage SDK dependencies.

## Build and Verification

The repository's General workflow delegates Java-only verification to this
file. The policy below governs this module's local verification, including
invoked skills, subagents, automations and PR follow-ups. Reference this
section instead of copying its rules into prompts or monitoring skills such
as `babysit-pr`. Changes in other packages still follow their applicable root
and module rules, including the root build/typecheck requirement for
cross-language changes.

### Local validation scope and budget

1. **Select by changed behavior.** Cover the current increment and affected
   callers, contracts and consumers. A new commit SHA, rebase or review round
   alone does not require repeating tests; inspect what actually changed.
2. **Reuse valid evidence.** Do not repeat a successful check while its tested
   source, tests, dependencies, toolchain, generated inputs and runtime
   configuration remain applicable. Record the command, tested state and
   outcome. When an input changes, rerun only checks whose evidence it
   invalidates. Preserve failed attempts; an isolated pass does not clear an
   unexplained wider failure.
3. **Preflight the environment.** Check required toolchain versions, build
   prerequisites and service configuration before expensive tests. Fix an
   environment mismatch before retrying the affected check; a full suite is
   not an environment diagnostic.
4. **Share one local budget.** Unless the user explicitly sets another budget,
   spend at most 10 minutes on this module's local verification per requested
   change, including prerequisite setup, builds, tests and retries. Subagents
   and review rounds share that budget; a new SHA or continuation message does
   not reset it. Give commands a timeout bounded by the remaining budget. At
   exhaustion, stop local checks, clean up task-owned resources and record
   incomplete checks for CI. Do not silently extend the budget or keep adding
   checks. This budget does not waive checks required for other changed packages.
5. **Keep full gates in CI.** Local validation prioritizes focused regression
   and the minimum real integration path. CI owns this module's required full
   suites and profiles; do not weaken their selectors or coverage guards.
   Report local passes, failures, skips and CI gaps separately. Until the
   required CI gates pass on the revision being accepted, say acceptance is
   pending; if CI does not cover a required check, keep that gap explicit.
6. **Expand only with evidence.** Name a concrete failure, changed shared
   contract or specific unresolved risk and the additional check that would
   resolve it. "More confidence" alone is insufficient. Expansion remains
   within the local budget; otherwise hand it to CI. Self-audit checks the
   validity of evidence without automatically rerunning it.

### Maven and MySQL checks

Use JDK 21 and Maven 3.8.9 or newer; run Maven from this directory. This is the
reactor parent. Production modules compile independently; all tests and fixtures
live in `verification`. Preserve the dependency matrix in the
[Maven modules design](../../docs/design/2026-10-29-managed-agent-maven-modules.md).
Checkstyle and SpotBugs apply to every production module. Test reports and
aggregate coverage live under `verification/target`; executable artifacts live
under `server/target`. The verification module must never be installed or
published.

Before testing, check the toolchain and that the installed sibling SDK matches
the source being tested. Reuse a valid build; otherwise install it once into
the task's isolated Maven repository to avoid another checkout's same-version
artifact. Use the same task-specific `-Dmaven.repo.local` setting for installation
and subsequent Maven commands (it may be supplied through `MAVEN_ARGS`):

```bash
mvn -f ../sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
```

Native CSI conformance tests also load built Core and CLI JavaScript. When
selecting those tests, check `packages/core/dist` and `packages/cli/dist` and
build missing or stale prerequisites under the root dependency instructions.
Maven does not build them. Setup and build time count toward the local budget.

For local Java changes, select the affected classes and their consumers:

```bash
mvn -Dtest=ChangedClassTest test checkstyle:check
```

Replace `ChangedClassTest` with the affected test classes. Do not follow a
successful focused run with unconditional local `mvn verify`. CI runs the full
unit/H2 suite, Checkstyle and SpotBugs through `mvn verify`; broader local checks
need the concrete evidence and remaining budget required by this module's policy.
Java formatting and style follow the existing
[Checkstyle rules](../sdk-java/qwencode/qwen-code-checks.xml). Justify any new SpotBugs
exclusion in the PR; do not disable a gate to make verification pass.

SQL, transaction, concurrency, or recovery changes require real MySQL evidence:
locally select the affected `mysql-integration` cases against a disposable
MySQL 8.4 database within budget, and leave the complete profile to CI. Hosted
execution or failure recovery changes similarly need the relevant real-process
path locally and the matching full Hosted/fault profiles in CI. Profiles are in
[pom.xml](pom.xml). Focused local reports prove only their selected cases; the
complete-source-tree report guard belongs to unfiltered full runs. Use the README and the repository's
[Java workflow](../../.github/workflows/sdk-java.yml) for setup and profile
parameters. H2 tests alone do not establish MySQL or process-recovery behavior.
If the required real path cannot run locally within budget, record it as pending
CI rather than substituting H2 or claiming acceptance.

Before MySQL tests, verify the effective server version, task-owned database
URL/credentials and required permissions. Check settings needed by the selected
cases: large-object tests require `max_allowed_packet >= 134217728`; the
`mysql-integration` Linux CI containers disable native AIO with `--innodb-use-native-aio=0`; the MySQL leg also uses `--skip-log-bin`. Follow the workflow's
actual startup settings and record local platform deviations. Multi-fork runs
need a distinct MySQL instance per fork to isolate server-wide deadlock counters.
Repair an invalid environment before running tests; report unavailable checks
and remaining CI work explicitly.

For shared-contract or TypeScript-consumer changes, also follow the root
build/typecheck requirements and run affected consumer tests. The local Maven
work follows this module's budget; CI retains the full cross-language gates.
Documentation-only changes need formatting and reference checks and do not
invalidate unchanged Java test results.

Maven output under every module's `target/` is ignored by Git, ESLint and
Prettier. Keep these exclusions when adding modules so generated reports and
packaged fixtures are not linted or committed as source.

## Code Review

- Preserve each changed route's tenant isolation, actor checks, Workspace
  grants, and internal credentials. A tenant header alone must not authorize
  protected Workspace or artifact access; preserve the documented loopback and
  signed-authentication boundaries.
- Keep admitted operations and recovery decisions durable in SQL. Verify retry
  idempotency and writer lease/generation checks across restarts: a stale owner
  must not commit durable state or release a newer owner's resources.
- Server and Broker use the
  [shared schema baseline](persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql).
  Until the first formal Managed Agent release, edit this V1 baseline in place;
  do not add V2+ migrations or increment the database schema version. Recreate
  development catalogs after baseline changes rather than maintaining upgrades.
  Keep initialization and validation consistent across Server and Broker. Preserve
  refusal of legacy, partial, and foreign catalogs; do not revive archived
  migrations or use Flyway repair/history edits to bypass that refusal. Follow
  the README's current schema policy rather than assuming an upgrade path.
- Public and WebShell API changes must keep the
  [OpenAPI contract](contracts/src/main/resources/openapi/managed-agent-public-api.openapi.json),
  mapped routes, `SurfaceRegistry`, and contract tests consistent. Run
  `ManagedAgentApiContractTest` and `SurfaceRegistryGateTest` for those changes.
  Regenerate WebShell types from the repository root with
  `npm run generate:managed-agent-api --workspace=packages/web-shell` and verify
  affected consumers; update the contract rather than hand-editing generated
  types.
