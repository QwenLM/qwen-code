# Managed Agent capability parity matrix

[简体中文](2026-10-21-managed-capability-parity.zh-CN.md)

## Motivation

The repository maintains two server paths: the legacy `qwen serve` daemon and
the Managed Agent control plane. They share one TypeScript agent core. They
differ in control plane, isolation model, and operations. No single place
states which capability lives on which path. A user cannot tell whether a
feature exists on both paths. A contributor who adds a legacy capability gets
no signal that the Managed path is now out of sync.

Issue #15075 asks for a checked matrix. The matrix reports differences. It
does not require the differences to be closed.

## Sources

| Side           | Source                                                                                                | Read by                         |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------- |
| Legacy tags    | `SERVE_CAPABILITY_REGISTRY` in `packages/cli/src/serve/capabilities.ts`                               | TypeScript test                 |
| Managed tools  | Hosted Workspace profile declarations in `hosted-workspace-tool-turn.ts` and `hosted-team-session.ts` | TypeScript test                 |
| Managed routes | `SurfaceRegistry` (Java enum)                                                                         | Committed twin, checked by Java |

## Design

### One row per legacy tag

`CAPABILITY_PARITY` in `packages/cli/src/serve/capability-parity.ts` holds one
row for each legacy tag. The record type is `Record<ServeFeature, ParityRow>`,
so a new legacy tag does not compile until it has a row. Each row states one of
three standings:

- `managed`: the Managed path stands behind the tag. The row names its
  evidence.
- `legacy`: a legacy-daemon concern. The Managed control plane does not own it.
  The row states why.
- `absent`: a Managed gap. The row states why it is absent.

`capabilityParityMatrix()` projects the rows onto three columns: `legacy only`,
`both`, and `managed only`.

### Evidence must resolve in code

A row that says `managed` names evidence tokens. The test checks each token
against the code:

- `tool:<name>`: a Hosted Workspace profile declares the tool.
- `surface:<CAPABILITY>`: a route exists for this `SurfaceRegistry.Capability`.
- `docs:<path>`: the named file exists (never a directory).

A row that names evidence which no longer exists fails the suite. A prose claim
cannot do that.

### The Java route set

The TypeScript test cannot read a Java enum. The committed file
`packages/managed-agent-server/src/test/resources/capability-parity/managed-surface.txt`
is the twin of `SurfaceRegistry`. Each line is
`label method template surface`. The header records the SHA-256 digest of the
sorted route lines.

`ManagedSurfaceCaptureTest` compares the file with the enum and never writes
on an ordinary run. Re-capture is opt-in, because a test that rewrites its own
baseline turns a second run green against data the first run edited:

```bash
mvn -Dtest=ManagedSurfaceCaptureTest -Dcapability.parity.capture=true test
```

`ManagedSurfaceCaptureTest` is the authority: it byte-compares the twin with
`render()`, which covers the label, method, template and surface columns. The
TypeScript side does not re-parse the enum. A parser that reads Java source
goes blind on shapes it cannot read and red on a correct re-capture, which is
what review round 2 demonstrated. It asserts the twin's internal consistency
instead: four fields per line, one line per route, and a header digest that
matches its own route lines.

## Boundaries

- The matrix does not judge whether one path should copy the other.
- Internal writer routes are outside the OpenAPI document. The registry alone
  lists them.
- The `managed only` column is derived: it lists route labels in the twin that
  no `managed` row cites. An exclusion set records why a label is not a gap,
  and every entry in that set must name a label the twin records. A route that
  is mounted with no legacy tag and no exclusion appears in the column, which
  is the signal #15075 asked for. The remaining labels are pinned in
  `MANAGED_ONLY_REPORTED`, so an addition fails the suite until someone
  records it. The column currently reports twelve labels: nine `EXTENSION_*`
  labels describe package publication, archive access, settings, operation
  queries and Session configuration. Their Session-pinned contract differs
  from the daemon's extension APIs; recording them does not establish legacy
  API compatibility or platform acceptance. `SESSION_CONTEXT_COMPRESSION`
  compresses a Session's context, `SESSION_RECOVERY_QUERY` reads its recovery
  state, and `SESSION_RECOVERY_RECHECK` re-runs its recovery checks.

## Acceptance

- `cd packages/cli && npx vitest run src/serve/capability-parity.test.ts`
  passes.
- `cd packages/managed-agent-server && mvn -Dtest=ManagedSurfaceCaptureTest,SurfaceRegistryGateTest,ManagedAgentApiContractTest test`
  passes.
- Add a tag to `SERVE_CAPABILITY_REGISTRY` without a row: the TypeScript test
  run fails to compile.
- Change a Managed evidence target: the TypeScript test fails and names the
  token.
- Change `SurfaceRegistry` without re-capturing: the Java test fails.
- The module's Checkstyle gate stays green:
  `mvn --batch-mode --no-transfer-progress checkstyle:check checkstyle:check@runtime-broker-checkstyle`.
