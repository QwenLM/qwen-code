# P2 npm security upgrades

[English](npm-p2-security-upgrades.md) | [简体中文](npm-p2-security-upgrades.zh-CN.md)

## Problem and scope

Issue #17099 records the remaining consumer scan findings. This assessment
starts from P1 PR #17105, commit `1c5be65bb8`. That PR fixes DOMPurify, MCP SDK
and body-parser, but leaves five P2 packages below their fixed versions.
Its pnpm tree has only node-server 2.x; the independent Mobile MCP npm lock
still contains 1.19.17. A workspace-only check would miss that path.

## Decisions and consumers

| Package           | Baseline                        | Target                    | Consumers and exposure                                                                                                                                                                                                                     |
| ----------------- | ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| qs                | 6.16.0 and 6.17.1               | 6.17.1                    | Express query parsing, GitLab/Feishu clients and Mobile MCP. No first-party stringify call; GitLab uses brackets and Feishu repeat, not comma or allowEmptyArrays.                                                                         |
| fast-uri          | pnpm 3.1.7; Mobile npm 3.1.5    | 3.1.9                     | Core declaration and AJV schema/reference resolution throughout MCP and tool validation. No direct production import or custom suffix option. URI normalization changes still require schema regression.                                   |
| ip-address        | 10.5.0                          | 10.7.4                    | express-rate-limit through MCP; socks through email and build tooling. Rate limiting gates Address6 with Node isIPv6; socks parses already classified IPv6 addresses. The malicious zone/newline input is not a demonstrated product path. |
| hono              | 4.13.3                          | 4.13.18                   | Transitive MCP dependency. No owned serveStatic/validator/bodyLimit/mount consumer; the SDK Node transport uses the adapter's getRequestListener.                                                                                          |
| @hono/node-server | pnpm 2.0.12; Mobile npm 1.19.17 | 2.1.7; Mobile npm 1.19.19 | Preserve each installed major and Mobile's Node 18 declaration. MCP SDK 1.32.2 accepts both adapter majors. No Vercel adapter use.                                                                                                         |

Add exact matching npm/pnpm workspace overrides. Raise Core's fast-uri and
Mobile's qs minimums so their published manifests do not keep the old minimum.
Mobile's independent npm install gets its own overrides, retaining adapter 1.x;
the Node 22 workspace keeps adapter 2.x. Consumer lockfiles still require an
explicit refresh, since dependency overrides are not inherited on publication.

## Advisory evidence

- qs: [comma coercion](https://github.com/ljharb/qs/security/advisories/GHSA-6pq8-jhm2-2vcw)
  affects 6.7.0–6.16.0; [empty-array key injection](https://github.com/ljharb/qs/security/advisories/GHSA-w4cr-vjpx-p82q)
  has a 6.16.2 backport and is fixed in 6.17.0+. Parent PR already resolves
  body-parser's copy to 6.17.1; this change removes other residual 6.16.0 copies.
- fast-uri: [scheme injection](https://github.com/fastify/fast-uri/security/advisories/GHSA-333x-w4r6-6crp),
  [encoded scheme](https://github.com/fastify/fast-uri/security/advisories/GHSA-w74x-v6f9-j3xg),
  [host confusion](https://github.com/fastify/fast-uri/security/advisories/GHSA-wjr9-j795-jxcr)
  and [relative references](https://github.com/fastify/fast-uri/security/advisories/GHSA-xhq7-xmqj-769h)
  are fixed in 3.1.9 within 3.x.
- ip-address: [quadratic zone matching](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rxp7-6hxx-x8q5)
  affects <=10.7.3; fixed in 10.7.4.
- Hono [double decoding](https://github.com/honojs/hono/security/advisories/GHSA-5r4p-p66f-jhc7)
  affects 4.12.4–4.13.10. Use [4.13.18](https://github.com/honojs/hono/releases/tag/v4.13.18)
  to include subsequent validator, body buffering, mount and allowPercentInPath
  fixes; introducing that option solely to retain old behavior is unnecessary.
- Node adapter [double decoding](https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f)
  is fixed in 2.1.3 and [1.19.19](https://github.com/honojs/node-server/releases/tag/v1.19.19).
  The [allowPercentInPath follow-up](https://github.com/honojs/node-server/security/advisories/GHSA-fj57-4f93-cfw6)
  affects 2.1.3–2.1.6 and is fixed in 2.1.7; the 1.19.19 backport includes that
  hardened implementation. Global advisory metadata may lag the official 1.x
  backport. Use 2.1.7, which contains both security fixes and meets the package
  age policy; 2.1.8 is too recent and must not receive an age-policy exemption.

## Compatibility and deferred work

All five upgrades preserve their existing major versions. No production
configuration, daemon route, authentication boundary or public option changes.
URI handling, serialization and HTTP adapter behavior are the regression risks.
Rebuild artifacts and notices; overrides cannot change an old embedded bundle.

Keep minimatch separate: GHSA-g3hv-75wg-m249 affects 7–10, fixes only 11.0.1,
and requires optimizationLevel >=2, which owned callers do not select. Existing
9.0.9/10.2.5 copies remain upgrade debt, not a proven reachable product exploit.
The scan's 3.1.5/5.1.9 copies are outside that particular advisory's range.

Keep ExcelJS/inflight/unzipper coordinated with #16434. ExcelJS 4.4.0 still
depends on archiver 5 and unzipper 0.10; removing inflight requires parent-chain
work, and unzipper 0.10→0.12 changes its pre-1.0 compatibility range. The owned
browser preview rebuild uses JSZip; ExcelJS's streaming reader uses unzipper
Parse, not disk Extract. Do not claim that the scan's disk-extraction vector
is reachable in the preview. These paths and npm publication/consumer rescan
remain explicitly open in #17099.

Other independent lockfiles are not this workspace's install tree: the CUA
agent-SDK example still contains all five older packages, its Electron fixture
contains ip-address 10.3.1, and excluded live-host contains fast-uri 3.1.6.
Track them separately with #13169, which already changes the CUA example lock;
do not infer that every repository lock or published artifact is now fixed.
The CUA example is a private runnable example; the Electron lock belongs to a
private test harness and marks ip-address as dev-only. Live Host is also private
but is actively built by live-host-release.yml using its own npm ci, so it must
not be called retired: fast-uri is dev-only build-tool debt there. #17099 keeps
these as explicit follow-ups for the CUA/Live Host maintainers, without inventing
an assignee or claiming their release verification is covered by this PR.

## Validation and acceptance

Before dependency edits, reproduce applicable library behaviors independently
and check product reachability. Then verify the same probes, normal schema
references, Express query behavior, MCP initialization/tool calls, IPv4/IPv6
proxy/rate-limit paths and adapter request/response streaming. Run focused Core,
SDK, CLI, email/GitLab/Feishu and Mobile non-device tests; build, bundle and
typecheck the complete workspace. Validate frozen pnpm and independent Mobile
npm locks, generated notices and packed SDK resolution. Record actual OS and
test coverage without treating a version bump as a real product exploit test.

Acceptance requires no vulnerable copies of these five packages in either
tested lock tree, passing targeted regressions and accounted-for artifact
changes. An advisory database falsely including the official 1.19.19 backport
must be reported with evidence rather than hidden. Windows/Linux, real mobile
devices, package publication and the original consumer scan remain separate.
