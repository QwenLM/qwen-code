# Review repository context

## Problem

The review pipeline needs a bounded way to add repository-specific guidance without teaching the shared roster, prompt, coverage, and composition layers about individual repositories. Repository identity is security-sensitive for pull request reviews because the reviewed branch must not be able to opt into privileged context by changing its own metadata.

## Design

A review plan may contain a versioned `repositoryContext` object with a provider identifier, human-readable label, domains, related paths, recommended tests, required configurations, required agent roles, unverified dimensions, and verification notes. The shared validator rejects unknown fields, unsafe or oversized values, unsafe repository-relative paths, unsorted or duplicate arrays, and agent roles that do not already exist in the review roster.

`repo-context` owns plan parsing, worktree matching, merge-base validation, provider dispatch, and atomic artifact and plan writes. Providers are a static in-process list. The first matching provider returns a complete context; no dynamic plugin or registry mechanism is introduced. The initial foundation has no built-in providers, so unsupported repositories deterministically write a `null` artifact and remove stale plan context.

Providers receive the resolved worktree, validated changed paths, and `readIdentityFile(relativePath)`. For pull request plans, identity reads come only from the trusted merge-base commit recorded by the fetch stage. For local plans, identity reads come from the current tree after safe-relative-path validation and realpath containment. Provider output always passes through the shared schema validator.

Code-review agents receive the generic context headed by its label. The build-and-test role receives only the recommended tests, required configurations, and verification notes. Required roles are merged into the normal roster without duplication. Composition discloses unverified dimensions as non-blocking proof boundaries.

## Scope

This change provides the generic contract and trust boundary only. Repository-specific detection, classification, specialists, executable verification, dynamic plugins, and provider registries are out of scope.
