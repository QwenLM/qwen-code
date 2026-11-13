# npm transport security restoration

[English](npm-transport-security-restoration.md) | [简体中文](npm-transport-security-restoration.zh-CN.md)

## Problem and scope

PR #13169 updates vulnerable transport dependencies but predates the current
workspace layout. Its old CI results cannot validate a merge with current main.
The merged lock has dangling undici references in the DingTalk and Feishu
importers. The independent CUA agent example also retains older MCP dependencies
and metadata for local SDK 0.20.11 instead of the current 0.27.0.

This work preserves the author's axios 1.20.0 and @grpc/grpc-js 1.14.5 targets,
restores compatibility with main, and updates the independent example. It does
not change transport implementation, authentication or application behavior.

## Decisions

Use undici 7.30.2 throughout the 7.x workspace graph and declare ^7.30.2 in
Core, CLI, DingTalk, Feishu, external-context and its copyable provider example.
The previous 7.30.0 target is affected by later advisories including
[GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) and
[GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26), fixed
in 7.30.1. Version 7.30.2 stays on the supported major and satisfies the existing
package-age policy. Keep npm and pnpm overrides aligned; published consumers
must resolve their own locks and do not inherit repository overrides.

Retain main's MCP, Zod and exact fast-uri security floors. Do not restore the
removed CUA TypeScript npm lock: that package now belongs to the pnpm tree.
Regenerate both lock graphs instead of resolving conflict markers alone.

In the independent CUA agent example use Zod 4.6.6, MCP SDK 1.32.2,
@hono/node-server 1.19.19, Hono 4.13.18, body-parser 2.4.0, qs 6.17.1,
fast-uri 3.1.9 and ip-address 10.7.4. Preserve the official 1.x node-server
backport and the existing third-party agent SDK versions. Refresh metadata
from the actual local SDK manifest. These are the targets already established
by #17099, not proof that previously released packages have been replaced.

## Consumers and constraints

Undici reaches Core downloads, proxy/fetch utilities, IDE/image transport,
CLI preconnect and setup/update paths, channel transports and provider proxy
dispatch. Axios reaches the Feishu, WeCom and DingTalk SDK parents. grpc-js
reaches OTLP gRPC exporters and the optional A2A SDK peer. The CUA example is
outside the workspace and needs its own clean install and typecheck.

Keep dependency upgrades separate from product refactors. Preserve main's CI
gate and Java layout; do not invent CI workarounds for obsolete failures.
Never relax release-age checks. Model credentials, native GUI interaction and
other operating systems are separate verification boundaries.

## Validation and acceptance

Require a frozen workspace install with no dangling importer references,
lockfile checks, build, bundle, typecheck, relevant lint and generated notices.
Run the transport, channel, telemetry and A2A tests that exercise these parents,
plus local HTTP/redirect and unary gRPC integration controls. Verify actual
resolved versions rather than manifest intent.

Require an independent CUA example install, current local SDK build, example
typecheck and a credential-free MCP transport/schema smoke test. Record audit
changes against main and remaining findings. A passing high-severity gate does
not establish a clean audit, release, deployment or original-scan closure.

Status: implementation and validation in progress. Fresh PR CI, review and merge
remain required; historical CI and reviews are not evidence for the new head.
