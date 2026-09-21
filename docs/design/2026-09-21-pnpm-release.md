# Native pnpm release operations

[English](2026-09-21-pnpm-release.md) | [简体中文](2026-09-21-pnpm-release.zh-CN.md)

## Scope and decisions

Replace the main release's hand-written workspace publish loop and per-package
version commands with the repository's pinned pnpm. Keep independent releases,
version-collision guards, OIDC/provenance, optional-package gates, and generated
CLI packaging unchanged. This does not dispatch or merge a release.

Internal source packages declare `private: true`. SDK, Mobile MCP, Node REPL,
and Qwen Live remain public and independently versioned. The GitLab channel is
private because the existing release does not publish it. The generated CLI
manifest remains public; neither the repository root nor CLI source is published.

Derive release workspace names from workspace manifests, excluding private and
independent packages. Use that selection for both recursive publication and
version-collision checks. The guard checks optional packages even when their
publication gates are disabled, preserving its conservative behavior. Check out
the selection helper and manifests at the workflow SHA so a release-ref checkout
cannot replace the push guard's package list.

Run `pnpm -r publish` with explicit package filters, provenance, access, and tag.
pnpm handles dependency order and skips versions already on the registry.
`--force` is used only with `--dry-run` so existing versions still exercise their
packing and lifecycle checks. Publish the generated CLI separately after the
workspaces. Keep its existing version-skip check. A workspace failure stops the
step before CLI publication; publishing multiple packages is not atomic.

Resolve the root version once and use recursive versioning to align all coupled
workspaces, including private ones. Keep extension metadata, sandbox image tags,
and exact channel-base dependency pins aligned. pnpm version does not rewrite
those exact dependency pins. Remove the old npm-reify node_modules cleanup.

## Verification and acceptance

- The effective published package set matches the existing set plus the Web
  Shell restoration in #12387; independent releases remain excluded.
- Tests cover gated selection, workflow-pinned manifests, existing CLI versions,
  tag/provenance arguments, dry-run flags, and failure propagation.
- Exercise native pnpm against a local registry: first/partial/complete releases,
  dependency order, private exclusions, dry-run with no writes, and registry
  failures. Preserve the trusted guard: pnpm's existence probes alone do not
  fail closed on registry errors.
- Run actual versioning against temporary manifests and compare packed artifacts
  and installability. Run targeted tests, build, and typecheck.
- No live npm release is part of verification. OIDC exchange and provenance on
  GitHub-hosted runners require a subsequently authorized real release; local
  dry-run cannot prove them.

## Risks and follow-up

Adding a non-private, non-independent workspace now opts it into the main release.
Review its npm permissions and trusted publisher before merging it. `private`
prevents publication; it does not change an already published package's access.
The CLI still needs its generated manifest and bundling logic, so this is a
bounded simplification rather than replacement of the whole release workflow.
