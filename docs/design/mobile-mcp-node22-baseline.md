# Mobile MCP Node.js 22 Baseline

## Decision

`@qwen-code/mobile-mcp` requires Node.js 22 or later, pins
`@modelcontextprotocol/sdk` 1.30.0, and directly requires
`@hono/node-server` `^2.0.12`.

The package is released independently from Qwen Code, but its release workflow
already uses the repository `.nvmrc`, which selects Node.js 22. The repository
does not test or publish this package on Node.js 18. The upstream
`mobile-next/mobile-mcp` package has also moved its baseline to Node.js 20.
Keeping the fork's Node.js 18 declaration would therefore advertise an
untested compatibility promise.

## Dependency boundary

MCP SDK 1.26.0 restricts `@hono/node-server` to the vulnerable 1.x line covered
by [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9).
MCP SDK 1.30.0 permits Hono Node Server 2.0.5 or later, whose engine requires
Node.js 20 or later, but its compatibility range also permits Hono 1.x. An
existing consumer lockfile can therefore retain Hono 1.x when only the SDK is
upgraded. The direct `@hono/node-server` `^2.0.12` requirement removes that
upgrade path while remaining compatible with the SDK. The caret range keeps
the same "never 1.x" guarantee while still receiving future 2.x patches.
Using the repository's Node.js 22 baseline makes the resulting dependency
resolution supported by both the package declaration and the release
environment.

`@hono/node-server` is declared as a resolution floor, not because the fork
imports it directly: no source file references it. It must not be removed in a
dependency cleanup. A `depcheck`-style pass will report it as unused, but
dropping it reopens the Hono 1.x upgrade path that the SDK's permissive peer
range otherwise allows.

The monorepo workspace and the published package resolve Zod differently. In
the workspace, npm hoists the SDK to the repository root, where it resolves the
root `zod@3`, while `packages/mobile-mcp` keeps its own `zod@4`; the two
installations are nominally incompatible in TypeScript even though SDK 1.30.0
validates both Zod 3 and Zod 4 schemas at runtime. The mobile server therefore
bridges the mismatch with a single compile-time cast (`sdkInputSchema` in
`src/server.ts`) when it passes its local schemas to the SDK. The cast does not
transform schemas or change validation behavior.

The published package does not have this split. The release workflow
(`cd-mobile-mcp.yml`) installs against the standalone
`packages/mobile-mcp/package-lock.json`, which resolves a single `zod@4`, and
builds and runs the non-device Playwright suites in that layout. The workspace
cast exists only to keep the monorepo's TypeScript build green; it is never
exercised by the configuration that ships. Aligning the workspace on a single
Zod copy would remove the cast entirely and is follow-up work, not part of this
security change.

This change addresses only the MCP SDK/Hono advisory tracked by #8269. Other
production audit findings, including findings in the independently versioned
mobilewright dependency tree, remain separate upgrade decisions.

## Verification

- Generate both the repository and standalone mobile package lockfiles.
- Build in both workspace and standalone installations, then run the
  non-device Playwright suite on Node.js 22.
- Inspect `npm pack` and confirm the packed manifest declares Node.js 22,
  MCP SDK 1.30.0, and Hono Node Server `^2.0.12`.
- Run a production dependency audit and confirm it no longer reports
  `@modelcontextprotocol/sdk` or `@hono/node-server` through mobile-mcp.

## Compatibility and rollback

Node.js 18 and 20 consumers must upgrade their runtime before installing the
next mobile-mcp release. Rolling back the runtime baseline would also require a
supported MCP SDK dependency path that does not restore the vulnerable Hono 1.x
tree; forcing Hono 2 beneath MCP SDK 1.26.0 is not supported.

Because the `engines` bump is breaking for consumers, the next mobile-mcp
release tag should be a minor bump rather than a patch.

## Follow-up work

Two deferred items are intentionally out of scope for this security change and
are recorded here so they do not evaporate:

- Align the monorepo workspace on a single Zod copy, then delete the
  `sdkInputSchema` cast in `src/server.ts` that bridges the workspace's split
  Zod resolution.
- Add a mobile-mcp CI job that runs `tsc --noEmit` and the non-device
  Playwright suites, closing the coverage gap that predates this change.

These items do not yet have a tracking issue; one should be opened and linked
here.
