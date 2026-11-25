# Manifest-only workspace extension projection

[English](workspace-extension-catalog.md) | [简体中文](workspace-extension-catalog.zh-CN.md)

## Problem and scope

`GET /workspaces/:workspace/extensions` loads all extension subresources even
though its response only uses identity and activation fields. The management
page also requests full extension status, duplicating this work.

## Decision

Use `refreshCatalogSnapshot()` and map its returned extensions together with
its snapshot. This reuses the catalog loader introduced by #12153 without
changing the response schema or core loading behavior.

This route is selected-runtime scoped. Preserve runtime resolution, workspace
cwd, trust handling, the post-read generation guard, and desired/applied
generation reporting. Resolve activation from the same returned snapshot;
never fall back to the primary runtime or separately fetch activation state.

## Constraints and validation

Preserve inherited and explicit workspace activation, linked installation
identity, and error propagation. Keep the existing full-status and skill-state
routes unchanged. Do not add caches, change lock behavior, or alter mutations.

Route tests must verify that the catalog loader is called and the full refresh
and loaded-extension cache are not read. A real filesystem fixture verifies
linked and regular entries, a selected-workspace override, and generations.
Existing reconciliation tests must continue to cover generation rollback and
out-of-order operations. Run the affected route suites, build, and typecheck.

## Follow-up

Request coalescing, detail loading, and cache invalidation are separate work.
No latency percentage is claimed without an endpoint benchmark.
