# Qwen Managed Workspace Binding

This Java 21 module implements the W0a slice of the Managed Agent Workspace design: [Managed Workspace Binding Contract](../../../docs/design/2026-09-25-managed-workspace-binding-contract.md). It defines:

- the Workspace Registry record, a tenant-scoped read contract, and an immutable snapshot built from deployment configuration, with a check that a replacement snapshot never drops a Workspace, lowers its generation, or swaps its storage silently;
- actor-scoped access (`NONE`, `READ`, `CREATE`) and an explicit-grant policy;
- `WorkspaceCatalog`, which lists the Workspaces an actor can read and resolves a Session's Workspace selection to one resolved Workspace or one typed error (`workspace_required`, `workspace_not_found`, `workspace_forbidden` or `workspace_unavailable`); an invalid directory already fails with `invalid_cwd` when the selection is built;
- the lexical rule and normal form of a Session's working directory relative to its Workspace;
- `ContextBinding` and its `contextDigest`.

The TypeScript implementation in `packages/cli/src/serve/managed-workspace-binding.ts` produces the same normalized directories and the same digests. Both run the shared fixtures in `packages/cli/src/serve/contracts/managed-workspace-binding-v1.fixtures.json`.

The module does not persist Session bindings, resolve storage to a mount, wire the Runtime Broker, Harness or worker, expose an HTTP API, or advertise `workspace_context`. Those belong to later W0 slices. It has no runtime dependencies.

Building and running this module requires JDK 21 or later.

```bash
mvn test
mvn checkstyle:check
```
