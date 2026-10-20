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

Use JDK 21 and Maven 3.8.9 or newer. Run the following commands from this
directory. On a fresh checkout, install the sibling dependencies first:

```bash
mvn -f ../sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
```

The native CSI conformance tests also load built Core and CLI JavaScript. On a
fresh worktree, follow the root dependency setup and run the root build once
to prepare `packages/core/dist` and `packages/cli/dist` before the full Maven
suite. Maven does not build those prerequisites.

For Java changes, run the affected tests first, then the module verification:

```bash
mvn -Dtest=ChangedClassTest test
mvn verify
```

Replace `ChangedClassTest` with the affected test classes. `mvn verify` runs the
unit/H2 tests, Checkstyle, and the SpotBugs high-confidence gate. Java formatting
and style follow the existing
[Checkstyle rules](../sdk-java/qwencode/qwen-code-checks.xml). Justify any new SpotBugs
exclusion in the PR; do not disable a gate to make verification pass.

SQL, transaction, concurrency, or recovery changes also require the
`mysql-integration` profile against a disposable MySQL 8.4 database. Changes to
Hosted execution or failure recovery require the matching Hosted/fault profiles
in [pom.xml](pom.xml). Use the README and the repository's
[Java workflow](../../.github/workflows/sdk-java.yml) for setup and profile
parameters. H2 tests alone do not establish MySQL or process-recovery behavior.
Report skipped or unavailable checks explicitly.

For changes to shared contracts or TypeScript consumers, also run the affected
consumer tests and the root build/typecheck requirements. Documentation-only
changes need formatting and reference checks.

Maven report output under `target/` (javadoc `reports/apidocs`, JaCoCo
`site/jacoco`) contains generated JavaScript that the repository-root ESLint
sweep does not ignore, so a root `npm run lint` fails while those directories
exist. Run `mvn clean` or delete the `target/` directories before running root
checks in the same checkout.

## Code Review

- Preserve each changed route's tenant isolation, actor checks, Workspace
  grants, and internal credentials. A tenant header alone must not authorize
  protected Workspace or artifact access; preserve the documented loopback and
  signed-authentication boundaries.
- Keep admitted operations and recovery decisions durable in SQL. Verify retry
  idempotency and writer lease/generation checks across restarts: a stale owner
  must not commit durable state or release a newer owner's resources.
- Server and Broker use the
  [shared schema baseline](src/main/resources/db/managed-schema/V1__managed_schema.sql).
  Keep initialization and validation consistent across Server and Broker. Preserve
  refusal of legacy, partial, and foreign catalogs; do not revive archived
  migrations or use Flyway repair/history edits to bypass that refusal. Follow
  the README's current schema policy rather than assuming an upgrade path.
- Public and WebShell API changes must keep the
  [OpenAPI contract](src/main/resources/openapi/managed-agent-public-api.openapi.json),
  mapped routes, `SurfaceRegistry`, and contract tests consistent. Run
  `ManagedAgentApiContractTest` and `SurfaceRegistryGateTest` for those changes.
  Regenerate WebShell types from the repository root with
  `npm run generate:managed-agent-api --workspace=packages/web-shell` and verify
  affected consumers; update the contract rather than hand-editing generated
  types.
