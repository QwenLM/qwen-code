# Review repository context

## Problem

The review pipeline needs a bounded way for repositories to declare review guidance without teaching shared roster, prompt, coverage, and composition code about individual projects. Repository metadata is security-sensitive for pull request reviews because the reviewed branch must not be able to opt into or remove trusted context.

## Manifest

A repository may provide strict JSON at `.qwen/review-context.json`:

```json
{
  "version": 1,
  "label": "Example repository",
  "rules": [
    {
      "paths": ["packages/*/src/**"],
      "relatedPaths": ["packages/*/src/**"],
      "domains": ["runtime"],
      "recommendedTests": ["test:runtime"],
      "requiredConfigurations": ["debug"],
      "requiredAgents": ["test-matrix"],
      "unverifiedDimensions": ["Alternate configuration"],
      "verificationNotes": ["Run the repository-native focused tests"]
    }
  ]
}
```

The top-level fields are exactly `version`, `label`, and `rules`. Each rule requires `paths`; all other rule fields are optional. Unknown or missing required fields, comments, unsupported versions, oversized values, control characters, unsorted arrays, and duplicate array entries are rejected. Rule order is preserved, while values from all matching rules are merged and returned sorted and unique.

`paths` and `relatedPaths` use repository-relative `/`-separated globs. Matching is case-sensitive on every platform and `?` consumes one UTF-16 code unit. The supported metacharacters are `*`, `?`, and a complete `**` path segment. Absolute paths, backslashes, empty or `.`/`..` segments, negation, brace expansion, character classes, and extended glob syntax are rejected.

A rule matches when any changed path matches one of its `paths` globs. If no rule matches, the provider returns no context. A matching rule's deduplicated `relatedPaths` globs are expanded from the worktree with dot files enabled, directory results disabled, symlink traversal disabled, and case-sensitive matching. Related globs must start with a non-wildcard directory segment so expansion cannot begin with a repository-wide wildcard; a completely static entry resolves to itself when it exists as a regular file. Changed paths are removed from the result. Resolved files must remain inside the worktree, and expansion fails closed when either the candidate-scan limit or bounded result limit is exceeded.

## Trust boundary

`repo-context` reads the fixed manifest path through `RepositoryContextProviderInput.readIdentityFile`. For pull request plans, the manifest therefore comes only from the trusted merge-base commit recorded by the fetch stage. The pull request head cannot opt in, opt out, or change the rules. For local plans, the manifest comes from the current worktree after safe-relative-path validation and realpath containment.

The manifest provider is statically registered in-process and returns the generic `RepositoryContext` shape with provider `manifest`. Its complete output passes through the shared `validateRepositoryContext` validator before downstream consumers use it. No dynamic plugin registry, shell execution, templates, or opaque payloads are supported.

## Review workflow

Medium- and high-effort local and same-repository pull request reviews invoke `repo-context` after the review plan is captured. The command receives absolute plan, worktree, and output paths. Low-effort reviews and cross-repository lightweight reviews skip repository context because they do not run the full local-tree workflow.

Code-review agents receive the generic context headed by its label. The build-and-test role receives recommended tests, required configurations, and verification notes. Required roles are merged into the normal roster without duplication. Composition discloses unverified dimensions as non-blocking proof boundaries.
