# Web Shell package artifact verification

Issue: #12185

## Baseline

1. Build `@qwen-code/web-shell` from upstream `main` through declaration emit, before any alias-rewrite step.
2. Confirm emitted declarations under `packages/web-shell/dist/types` contain repository-only `@/` specifiers.
3. Confirm `verify:package` rejects that unrevised declaration output.
4. Confirm the six runtime dependencies named in #12185 are not externalized by the upstream public-package library boundary.

## Fixed behavior

1. Run `npm run build --workspace=@qwen-code/web-shell`.
2. Run `npm run verify:package --workspace=@qwen-code/web-shell` and confirm every package export target exists and no emitted declaration contains an `@/` import.
3. Run the package test suite and confirm every declared dependency and peer dependency is external for the public package entries while the KaTeX and xterm CSS entrypoints remain bundleable.
4. Confirm the transcript build keeps `@modelcontextprotocol/ext-apps` bundled while externalizing the other declared runtime packages, then build `@qwen-code/web-templates`; the `/export html` renderer must remain within the existing JavaScript size budget from #11031.
5. Run `npm pack --workspace=@qwen-code/web-shell --dry-run` and inspect the publish artifact. `prepublishOnly` delegates to the same `verify:package` command exercised above, so the package guard and artifact contents are checked independently.
6. Run `npm run preflight` from the repository root.

## Transcript boundary evidence

The export-size diagnostic isolates `@modelcontextprotocol/ext-apps` as the dependency that must stay bundled for transcript builds. With it bundled, the downstream document renderer is 1,912,420 bytes and passes the 1,930,000-byte budget. Externalizing it pulls its MCP/zod dependency graph into the downstream export bundle and grows the renderer to 2,108,151 bytes, which fails the same budget. Public package entries still externalize `@modelcontextprotocol/ext-apps` and every other declared runtime dependency.

## Evidence policy

Record the exact commit SHA and command output. Do not treat a fork workflow waiting for upstream authorization as a passing or failing upstream CI result.
