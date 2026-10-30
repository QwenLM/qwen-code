# Capability parity: Managed Agent against the legacy daemon

The TypeScript side of the parity matrix (issue #15075). The test
`packages/cli/src/serve/capability-parity.test.ts` reads this file.

## Managed routes

`managed-surface.txt` is a copy of `SurfaceRegistry`. Each line is
`label method template surface`. The Java suite `ManagedSurfaceCaptureTest`
keeps the copy identical to the enum and never writes on an ordinary run.
Re-capture only when a registry change is intended:

```bash
mvn -Dtest=ManagedSurfaceCaptureTest -Dcapability.parity.capture=true test
```

Route-to-spec agreement is covered by `ManagedAgentApiContractTest` together
with `SurfaceRegistryGateTest`; this directory does not repeat those checks.

## Evidence

A `managed` row in `capability-parity.ts` names its Managed evidence. The
test checks each evidence token against the code:

- `tool:<name>`: a Hosted Workspace profile declares the tool.
- `surface:<CAPABILITY>`: `managed-surface.txt` records a route for this
  `SurfaceRegistry.Capability`.
- `docs:<path>`: the named file exists in the repository (never a directory).

A `docs:` token proves only that the file is there, never that the behavior
exists. Prefer a `surface:` or `tool:` token whenever one applies.

## The managed-only column

`managedOnlyLabels()` derives the third column: every route label no
`managed` row cites, minus `MANAGED_ONLY_NOT_A_GAP`. An exclusion entry must
name a label the twin records. Whatever remains is a real Managed-only
capability, pinned by `MANAGED_ONLY_REPORTED` so an addition fails the suite
until someone decides how to account for it.

The twin's authority is `ManagedSurfaceCaptureTest`, which byte-compares it
with `render()`. The TypeScript side reads the twin and checks its internal
consistency; it does not re-parse the Java enum.
