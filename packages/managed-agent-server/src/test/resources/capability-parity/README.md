# Capability parity: Managed Agent against the legacy daemon

The TypeScript side of the parity matrix (issue #15075). The test
`packages/cli/src/serve/capability-parity.test.ts` reads this file.

## Managed routes

`managed-surface.txt` is a copy of `SurfaceRegistry`. The Java suite
`ManagedSurfaceCaptureTest` keeps the copy identical to the enum. The test
`SurfaceRegistryApiTest` checks that every public and WebShell route appears
in the published OpenAPI document.

## Evidence

A `managed` row in `capability-parity.ts` names its Managed evidence. The
test checks each evidence token against the code:

- `tool:<name>`: a Hosted Workspace profile declares the tool.
- `surface:<CAPABILITY>`: `managed-surface.txt` records a route for this
  `SurfaceRegistry.Capability`.
- `route:<prefix>`: `managed-surface.txt` records a route with this prefix.
- `docs:<path>`: the file exists in the repository.
