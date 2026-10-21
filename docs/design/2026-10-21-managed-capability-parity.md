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
- `route:<prefix>`: a route exists with this prefix.
- `docs:<path>`: the file exists.

A row that names evidence which no longer exists fails the suite. A prose claim
cannot do that.

### The Java route set

The TypeScript test cannot read a Java enum. The committed file
`packages/managed-agent-server/src/test/resources/capability-parity/managed-surface.txt`
is the twin of `SurfaceRegistry`. Each line is `label method template`. The
header records the SHA-256 digest of the sorted route lines.

Two Java checks keep the twin honest:

- `ManagedSurfaceCaptureTest` compares the file with the enum. To re-capture,
  run `mvn -Dtest=ManagedSurfaceCaptureTest#capture test`.
- `SurfaceRegistryApiTest` compares each public and WebShell route with the
  published OpenAPI document, in both directions.

The TypeScript test parses `SurfaceRegistry.java` for its route set. A drift
between the twin and the enum fails on both sides.

## Boundaries

- The matrix does not judge whether one path should copy the other.
- Internal writer routes are outside the OpenAPI document. The registry alone
  lists them.
- The `managed only` column lists Managed capabilities with no legacy tag. It
  starts with the tail-events route.

## Acceptance

- `cd packages/cli && npx vitest run src/serve/capability-parity.test.ts`
  passes.
- `cd packages/managed-agent-server && mvn -Dtest=ManagedSurfaceCaptureTest test`
  passes.
- Add a tag to `SERVE_CAPABILITY_REGISTRY` without a row: the TypeScript test
  run fails to compile.
- Change a Managed evidence target: the TypeScript test fails and names the
  token.
- Change `SurfaceRegistry` without re-capturing: the Java test fails.
