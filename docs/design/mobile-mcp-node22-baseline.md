# Mobile MCP Node.js 22 Baseline

## Decision

`@qwen-code/mobile-mcp` requires Node.js 22 or later, pins
`@modelcontextprotocol/sdk` 1.30.0, and directly requires
`@hono/node-server` 2.0.12.

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
upgraded. The direct Hono 2.0.12 requirement removes that upgrade path while
remaining compatible with the SDK. Using the repository's Node.js 22 baseline
makes the resulting dependency resolution supported by both the package
declaration and the release environment.

The monorepo hoists the SDK beside a different Zod installation from the Zod
copy used by mobile-mcp. SDK 1.30.0 supports Zod 3 and 4 schemas at runtime,
but TypeScript treats schemas from those two installations as incompatible.
The mobile server therefore narrows this to a compile-time boundary when it
passes its local schemas to the SDK. The boundary does not transform schemas
or change validation behavior, and the server integration tests exercise the
same workspace resolution used by the release workflow.

This change addresses only the MCP SDK/Hono advisory tracked by #8269. Other
production audit findings, including findings in the independently versioned
mobilewright dependency tree, remain separate upgrade decisions.

## Verification

- Generate both the repository and standalone mobile package lockfiles.
- Build in both workspace and standalone installations, then run the
  non-device Playwright suite on Node.js 22.
- Inspect `npm pack` and confirm the packed manifest declares Node.js 22,
  MCP SDK 1.30.0, and Hono Node Server 2.0.12.
- Run a production dependency audit and confirm it no longer reports
  `@modelcontextprotocol/sdk` or `@hono/node-server` through mobile-mcp.

## Compatibility and rollback

Node.js 18 and 20 consumers must upgrade their runtime before installing the
next mobile-mcp release. Rolling back the runtime baseline would also require a
supported MCP SDK dependency path that does not restore the vulnerable Hono 1.x
tree; forcing Hono 2 beneath MCP SDK 1.26.0 is not supported.
