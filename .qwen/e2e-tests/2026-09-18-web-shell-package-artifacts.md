# Web Shell package artifact verification

Issue: #12185

## Baseline

1. Build `@qwen-code/web-shell` from upstream `main` through declaration emit, before any alias-rewrite step.
2. Confirm emitted declarations under `packages/web-shell/dist/types` contain repository-only `@/` specifiers.
3. Confirm the six runtime dependencies named in #12185 are not externalized by the upstream library config.

## Fixed behavior

1. Run `npm run build --workspace=@qwen-code/web-shell`.
2. Run `npm run verify:package --workspace=@qwen-code/web-shell` and confirm every package export target exists and no emitted declaration contains an `@/` import.
3. Run the package test suite and confirm every declared dependency and peer dependency is external while the KaTeX and xterm CSS entrypoints remain bundleable.
4. Run `npm pack --workspace=@qwen-code/web-shell --dry-run` and confirm packaging reaches the prepublish guard successfully.
5. Run `npm run preflight` from the repository root.

## Evidence policy

Record the exact commit SHA and command output. Do not treat a fork workflow waiting for upstream authorization as a passing or failing upstream CI result.
